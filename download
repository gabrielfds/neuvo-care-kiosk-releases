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
    try { chunks.push(await reader.transmit(Buffer.from([0xff, 0xb0, 0x00, page, 0x04]), 40)); }
    catch { break; }
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\0/g, ' ');
}
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() }));
});
const nfc = new NFC();
nfc.on('reader', (reader) => {
  reader.autoProcessing = false;
  readerConnected = true;
  readerName = reader.reader.name;
  console.log(`[neuvo-care-bridge] Reader connected: ${readerName}`);
  broadcast({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() });
  reader.on('card', async (card) => {
    try {
      const uid = card.uid || await getUid(reader) || toHex(card.atr);
      const rawPayload = await readNtagPages(reader).catch(() => uid);
      const payload = extractLikelyCode(rawPayload.match(/CARE-?\d{1,8}/i)?.[0] || rawPayload.match(/https?:\/\/\S+/i)?.[0] || uid);
      if (shouldDebounce(uid, payload)) return;
      broadcast({ type: 'nfc_read', payload, reader: readerName, uid, timestamp: new Date().toISOString() });
    } catch (error) { console.error('[neuvo-care-bridge] Tag read error:', error); }
  });
  reader.on('end', () => {
    readerConnected = false;
    readerName = null;
    broadcast({ type: 'bridge_status', readerConnected, reader: readerName, timestamp: new Date().toISOString() });
  });
});
nfc.on('error', (error) => console.error('[neuvo-care-bridge] NFC subsystem error:', error));
function getBridgeState() { return { serverStarted: server.listening, readerConnected, readerName, clients: wss.clients.size, port: PORT }; }
function startBridge(options = {}) {
  const logger = options.logger || console;
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve({ server, wss, nfc });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      logger.info?.(`[neuvo-care-bridge] Service started at http://localhost:${PORT}`);
      onStateChange(getBridgeState());
      resolve({ server, wss, nfc });
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
