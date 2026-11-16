const clients = new Set();

export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

export function emit(kind, payload = {}) {
  const frame = `event: ${kind}\ndata: ${JSON.stringify({ at: Date.now(), ...payload })}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

export function emitLog(message, extra = {}) {
  emit("log", { message, ...extra });
}
