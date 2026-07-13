const { startBridge, getBridgeState } = require('./bridge');
function send(type, payload = {}) {
  if (process.send) process.send({ type, ...payload });
}
startBridge({
  logger: {
    info: (...args) => { console.log(...args); send('log', { level: 'info', message: args.join(' ') }); },
    warn: (...args) => { console.warn(...args); send('log', { level: 'warn', message: args.join(' ') }); },
    error: (...args) => { console.error(...args); send('log', { level: 'error', message: args.join(' ') }); }
  },
  onStateChange: (state) => send('state', { state })
}).then(() => {
  send('started', { state: getBridgeState() });
  setInterval(() => send('state', { state: getBridgeState() }), 3000);
}).catch((error) => {
  send('error', { message: error?.stack || String(error) });
  console.error(error);
  process.exit(1);
});
process.on('uncaughtException', (error) => { send('error', { message: error?.stack || String(error) }); console.error(error); process.exit(1); });
process.on('unhandledRejection', (error) => { send('error', { message: error?.stack || String(error) }); console.error(error); process.exit(1); });
