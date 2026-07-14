const http = require('node:http');
const { NFC } = require('nfc-pcsc');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.NEUVO_CARE_BRIDGE_PORT || 8765);
const DUPLICATE_WINDOW_MS = Number(process.env.NEUVO_CARE_DUPLICATE_WINDOW_MS || 2000);
let readerConnected = false;
let readerName = null;
let lastReadKey = null;
let lastReadAt = 0;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, readerConnected, readerName, clients: wss.clients.size }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});
const wss = new WebSocketServer({ server });
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}
function toHex(buffer) { return Buffer.from(buffer || Buffer.alloc(0)).toString('hex').toUpperCase(); }
function shouldDebounce(uid, payload) {
  const key = `${uid || ''}:${payload || ''}`;
  const now = Date.now();
  if (key === lastReadKey && now - lastReadAt < DUPLICATE_WINDOW_MS) return true;
  lastReadKey = key;
  lastReadAt = now;
  return false;
}
function extractLikelyCode(text) {
  const raw = String(text || '').trim();
  const fromUrl = raw.match(/\/r\/([A-Z0-9-]+)/i)?.[1];
  return (fromUrl || raw).toUpperCase();
}
async function getUid(reader) {
  try { return (await reader.transmit(Buffer.from([0xff, 0xca, 0x00, 0x00, 0x00]), 40)).toString('hex').toUpperCase(); }
  catch { return null; }
}
async function readNtagPages(reader) {
  const chunks = [];
  for (let page = 4; page < 40; page++) {
    try {
        const resp = await reader.transmit(Buffer.from([0xff, 0xb0, 0x00, page, 0x04]), 40);
        // Strip 2-byte APDU status word (SW1 SW2) from each page response
        chunks.push(resp.length > 2 ? resp.slice(0, resp.length - 2) : resp);
      }
    catch { break; }
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\0/g, ' ');
}
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() }));
});

let nfc = null;
function initNfc(logger) {
  try {
    nfc = new NFC();
    nfc.on('reader', (reader) => {
      reader.autoProcessing = false;
      readerConnected = true;
      readerName = reader.reader.name;
      logger.info(`[neuvo-care-bridge] Reader connected: ${readerName}`);
      broadcast({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() });
      reader.on('card', async (card) => {
        // Broadcast immediately so the web client can show visual feedback even before reading
        const ts = new Date().toISOString();
        broadcast({ type: 'card_detected', reader: readerName, timestamp: ts });
        try {
          // uid is always a string — toHex(card.atr) is last resort
          const uid = card.uid || (await getUid(reader)) || toHex(card.atr) || 'unknown';
          logger.info(`[neuvo-care-bridge] Card detected uid=${uid} atr=${toHex(card.atr)}`);

          // Try manual APDU page read (NTAG213/215/216)
          const rawPages = await readNtagPages(reader).catch((e) => {
            logger.warn(`[neuvo-care-bridge] readNtagPages failed: ${e?.message || e}`);
            return null;
          });
          const rawPayload = rawPages || uid;
          logger.info(`[neuvo-care-bridge] rawPayload (first 120): ${String(rawPayload).slice(0, 120)}`);

          const careMatch = String(rawPayload).match(/CARE-?\d{1,8}/i)?.[0];
          const urlMatch  = !careMatch ? String(rawPayload).match(/https?:\/\/\S+/i)?.[0] : null;
          const payload   = extractLikelyCode(careMatch || urlMatch || uid);
          logger.info(`[neuvo-care-bridge] Extracted payload: ${payload}`);

          if (shouldDebounce(uid, payload)) { logger.info('[neuvo-care-bridge] Debounced'); return; }
          broadcast({ type: 'nfc_read', payload, reader: readerName, uid, timestamp: ts });
        } catch (error) {
          logger.error('[neuvo-care-bridge] Tag read error:', error?.stack || String(error));
        }
      });
      reader.on('end', () => {
        readerConnected = false;
        readerName = null;
        broadcast({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() });
      });
    });
    nfc.on('error', (error) => logger.error('[neuvo-care-bridge] NFC subsystem error:', String(error)));
  } catch (err) {
    logger.error('[neuvo-care-bridge] Failed to initialize NFC (no reader or PC/SC service unavailable):', String(err));
  }
}

function getBridgeState() { return { serverStarted: server.listening, readerConnected, readerName, clients: wss.clients.size, port: PORT }; }
function startBridge(options = {}) {
  const logger = options.logger || console;
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve({ server, wss, nfc });
    // Initialize NFC after server starts to avoid blocking startup
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      logger.info?.(`[neuvo-care-bridge] Service started at http://localhost:${PORT}`);
      onStateChange(getBridgeState());
      resolve({ server, wss, nfc });
      // Delay NFC init slightly so 'started' IPC is sent first
      setTimeout(() => initNfc(logger), 500);
    });
  });
}
function stopBridge() {
  return new Promise((resolve) => {
    for (const client of wss.clients) try { client.close(); } catch {}
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
module.exports = { startBridge, stopBridge, getBridgeState };
