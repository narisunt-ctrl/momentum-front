/*
 * Momentum Front — network transports
 *   PeerJS (WebRTC data channels, default)  -> real play across computers
 *   BroadcastChannel ("?net=local")         -> two tabs on one computer (testing)
 * Both expose the same tiny interface:
 *   Transport.host(code, onConn, onReady, onError)
 *   Transport.join(code, onOpen, onError) -> conn
 *   conn: { id, send(obj), onData(fn), onClose(fn), close() }
 * (c) 2026 Narisan Nakakes — MIT License
 */
(function (root) {
  'use strict';
  const PREFIX = 'mfront-v1-';

  function wrapPeerConn(c) {
    const conn = {
      id: c.peer, raw: c,
      send(obj) { try { if (c.open) c.send(obj); } catch (e) { /* ignore */ } },
      onData(fn) { c.on('data', fn); },
      onClose(fn) { c.on('close', fn); c.on('error', fn); },
      close() { try { c.close(); } catch (e) { /* ignore */ } },
    };
    return conn;
  }

  const PeerTransport = {
    available() { return typeof root.Peer === 'function'; },
    host(code, onConn, onReady, onError) {
      const peer = new root.Peer(PREFIX + code, { debug: 1 });
      peer.on('open', () => onReady && onReady());
      peer.on('connection', (c) => { c.on('open', () => onConn(wrapPeerConn(c))); });
      peer.on('error', (e) => onError && onError(e.type || String(e)));
      return { close() { try { peer.destroy(); } catch (e) { /* ignore */ } } };
    },
    join(code, onOpen, onError) {
      const peer = new root.Peer({ debug: 1 });
      let conn = null;
      peer.on('open', () => {
        const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        conn = wrapPeerConn(c);
        c.on('open', () => onOpen(conn));
        c.on('error', (e) => onError && onError(String(e)));
      });
      peer.on('error', (e) => onError && onError(e.type || String(e)));
      return { close() { try { if (conn) conn.close(); peer.destroy(); } catch (e) { /* ignore */ } } };
    },
  };

  // Loopback over BroadcastChannel (same browser, same origin)
  const LocalTransport = {
    available() { return typeof root.BroadcastChannel === 'function'; },
    host(code, onConn, onReady) {
      const bc = new BroadcastChannel(PREFIX + code);
      const conns = new Map();
      bc.onmessage = (e) => {
        const m = e.data;
        if (m.to !== 'host') return;
        if (m.kind === 'hello') {
          const handlers = { data: [], close: [] };
          const conn = {
            id: m.from,
            send(obj) { bc.postMessage({ to: m.from, from: 'host', kind: 'data', obj }); },
            onData(fn) { handlers.data.push(fn); }, onClose(fn) { handlers.close.push(fn); },
            close() { bc.postMessage({ to: m.from, from: 'host', kind: 'bye' }); },
            _h: handlers,
          };
          conns.set(m.from, conn);
          bc.postMessage({ to: m.from, from: 'host', kind: 'welcome' });
          onConn(conn);
        } else if (m.kind === 'data') { const c = conns.get(m.from); if (c) c._h.data.forEach((f) => f(m.obj)); }
        else if (m.kind === 'bye') { const c = conns.get(m.from); if (c) { c._h.close.forEach((f) => f()); conns.delete(m.from); } }
      };
      setTimeout(() => onReady && onReady(), 0);
      return { close() { bc.close(); } };
    },
    join(code, onOpen, onError) {
      const bc = new BroadcastChannel(PREFIX + code);
      const me = 'c' + Math.random().toString(36).slice(2, 8);
      const handlers = { data: [], close: [] };
      const conn = {
        id: me,
        send(obj) { bc.postMessage({ to: 'host', from: me, kind: 'data', obj }); },
        onData(fn) { handlers.data.push(fn); }, onClose(fn) { handlers.close.push(fn); },
        close() { bc.postMessage({ to: 'host', from: me, kind: 'bye' }); bc.close(); },
      };
      let opened = false;
      bc.onmessage = (e) => {
        const m = e.data;
        if (m.to !== me) return;
        if (m.kind === 'welcome' && !opened) { opened = true; onOpen(conn); }
        else if (m.kind === 'data') handlers.data.forEach((f) => f(m.obj));
        else if (m.kind === 'bye') handlers.close.forEach((f) => f());
      };
      bc.postMessage({ to: 'host', from: me, kind: 'hello' });
      setTimeout(() => { if (!opened) onError && onError('peer-unavailable'); }, 4000);
      return { close() { conn.close(); } };
    },
  };

  function pick() {
    const q = new URLSearchParams(root.location ? root.location.search : '');
    if (q.get('net') === 'local') return LocalTransport;
    return PeerTransport.available() ? PeerTransport : LocalTransport;
  }

  root.MFTransport = { pick, PeerTransport, LocalTransport };
})(typeof globalThis !== 'undefined' ? globalThis : this);
