const ts = () => new Date().toISOString();
type Lvl = 'info' | 'warn' | 'error' | 'debug';
function emit(lvl: Lvl, msg: string, meta?: unknown) {
  const line = `[${ts()}] ${lvl.toUpperCase()} ${msg}`;
  if (meta !== undefined) console.log(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
  else console.log(line);
}
export const logger = {
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
  debug: (m: string, meta?: unknown) => {
    if (process.env.DEBUG) emit('debug', m, meta);
  },
};
