const P = typeof globalThis > "u" ? window : globalThis, L = P.WebSocket, U = new TextEncoder(), R = U.encode.bind(U), k = new TextDecoder(), D = k.decode.bind(k);
class h {
  constructor(e) {
    if (e instanceof Uint8Array)
      this.from_array(e);
    else if (typeof e == "number")
      this.from_array(new Uint8Array(e));
    else if (typeof e == "string")
      this.from_array(R(e));
    else
      throw console.trace(), "invalid data type passed to wisp buffer constructor";
  }
  from_array(e) {
    this.size = e.length, this.bytes = e, this.view = new DataView(e.buffer);
  }
  concat(e) {
    let t = new h(this.size + e.size);
    return t.bytes.set(this.bytes, 0), t.bytes.set(e.bytes, this.size), t;
  }
  slice(e, t) {
    let s = this.bytes.slice(e, t);
    return new h(s);
  }
  get_string() {
    return k.decode(this.bytes);
  }
}
class f {
  static min_size = 5;
  constructor({ type: e, stream_id: t, payload: s, payload_bytes: n }) {
    this.type = e, this.stream_id = t, this.payload_bytes = n, this.payload = s;
  }
  static parse(e) {
    return new f({
      type: e.view.getUint8(0),
      stream_id: e.view.getUint32(1, !0),
      payload_bytes: e.slice(5)
    });
  }
  static parse_all(e) {
    if (e.size < f.min_size)
      throw TypeError("packet too small");
    let t = f.parse(e), s = C[t.type];
    if (typeof s > "u")
      throw TypeError("invalid packet type");
    if (t.payload_bytes.size < s.size)
      throw TypeError("payload too small");
    return t.payload = s.parse(t.payload_bytes), t;
  }
  serialize() {
    let e = new h(5);
    return e.view.setUint8(0, this.type), e.view.setUint32(1, this.stream_id, !0), e = e.concat(this.payload.serialize()), e;
  }
}
class b {
  static min_size = 3;
  static type = 1;
  static name = "CONNECT";
  constructor({ stream_type: e, port: t, hostname: s }) {
    this.stream_type = e, this.port = t, this.hostname = s;
  }
  static parse(e) {
    return new b({
      stream_type: e.view.getUint8(0),
      port: e.view.getUint16(1, !0),
      hostname: D(e.slice(3).bytes)
    });
  }
  serialize() {
    let e = new h(3);
    return e.view.setUint8(0, this.stream_type), e.view.setUint16(1, this.port, !0), e = e.concat(new h(this.hostname)), e;
  }
}
class g {
  static min_size = 0;
  static type = 2;
  static name = "DATA";
  constructor({ data: e }) {
    this.data = e;
  }
  static parse(e) {
    return new g({
      data: e
    });
  }
  serialize() {
    return this.data;
  }
}
class T {
  static type = 3;
  static name = "CONTINUE";
  constructor({ buffer_remaining: e }) {
    this.buffer_remaining = e;
  }
  static parse(e) {
    return new T({
      buffer_remaining: e.view.getUint32(0, !0)
    });
  }
  serialize() {
    let e = new h(4);
    return e.view.setUint32(0, this.buffer_remaining, !0), e;
  }
}
class x {
  static min_size = 1;
  static type = 4;
  static name = "CLOSE";
  constructor({ reason: e }) {
    this.reason = e;
  }
  static parse(e) {
    return new x({
      reason: e.view.getUint8(0)
    });
  }
  serialize() {
    let e = new h(1);
    return e.view.setUint8(0, this.reason), e;
  }
}
class w {
  static min_size = 2;
  static type = 5;
  static name = "INFO";
  constructor({ major_ver: e, minor_ver: t, extensions: s }) {
    this.major_ver = e, this.minor_ver = t, this.extensions = s;
  }
  static parse(e) {
    return new w({
      major_ver: e.view.getUint8(0),
      minor_ver: e.view.getUint8(1),
      extensions: e.slice(2)
    });
  }
  serialize() {
    let e = new h(2);
    return e.view.setUint8(0, this.major_ver), e.view.setUint8(1, this.minor_ver), e.concat(this.extensions);
  }
}
const C = {
  1: b,
  2: g,
  3: T,
  4: x,
  5: w
}, u = {
  CONNECT: 1,
  DATA: 2,
  CONTINUE: 3,
  CLOSE: 4,
  INFO: 5
}, _ = {
  TCP: 1,
  UDP: 2
};
class p {
  constructor() {
  }
  static parse() {
    return new p();
  }
  serialize() {
    return new h(0);
  }
}
class E {
  static id = 0;
  static name = "";
  static Server = p;
  static Client = p;
  constructor({ server_config: e, client_config: t } = {}) {
    this.id = this.constructor.id, this.name = this.constructor.name, e ? this.payload = new this.constructor.Server(e) : t && (this.payload = new this.constructor.Client(t));
  }
  static parse(e, t, s) {
    let n = new e({});
    if (s === "client")
      n.payload = e.Client.parse(t.slice(5));
    else if (s === "server")
      n.payload = e.Server.parse(t.slice(5));
    else
      throw TypeError("invalid role");
    return n;
  }
  serialize() {
    let e = new h(5), t = this.payload.serialize();
    return e.view.setInt8(0, this.constructor.id), e.view.setUint32(1, t.size, !0), e.concat(t);
  }
}
class z extends E {
  static id = 1;
  static name = "UDP";
}
class y extends E {
  static id = 4;
  static name = "Server MOTD";
  static Server = class {
    constructor({ message: e }) {
      this.message = e;
    }
    static parse(e) {
      return new y.Server({
        message: e.get_string()
      });
    }
    serialize() {
      return new h(this.message);
    }
  };
  static Client = p;
}
function O(i, e, t) {
  let s = 0, n = [];
  for (; i.size; ) {
    let o = i.view.getUint8(s), r = i.view.getUint32(s + 1, !0), a = i.slice(0, 5 + r), c;
    for (let d of e)
      if (d.id === o) {
        c = d.constructor;
        break;
      }
    if (c) {
      let d = E.parse(c, a, t);
      n.push(d);
    }
    i = i.slice(5 + r);
  }
  return n;
}
function $(i) {
  {
    let e = new h(0);
    for (let t of i)
      e = e.concat(t.serialize());
    return e;
  }
}
class H {
  constructor(e, t, s, n, o, r, a) {
    this.hostname = e, this.port = t, this.ws = s, this.buffer_size = n, this.stream_id = o, this.connection = r, this.stream_type = a, this.send_buffer = [], this.open = !0, this.onopen = () => {
    }, this.onclose = () => {
    }, this.onmessage = () => {
    };
  }
  send(e) {
    if (this.buffer_size > 0 || !this.open || this.stream_type === _.UDP) {
      let t = new f({
        type: u.DATA,
        stream_id: this.stream_id,
        payload: new g({
          data: new h(e)
        })
      });
      this.ws.send(t.serialize().bytes), this.buffer_size--;
    } else
      this.send_buffer.push(e);
  }
  //handle receiving a CONTINUE packet
  continue_received(e) {
    for (this.buffer_size = e; this.buffer_size > 0 && this.send_buffer.length > 0; )
      this.send(this.send_buffer.shift());
  }
  //construct and send a CLOSE packet
  close(e = 1) {
    if (!this.open) return;
    let t = new f({
      type: u.CLOSE,
      stream_id: this.stream_id,
      payload: new x({
        reason: e
      })
    });
    this.ws.send(t.serialize().bytes), this.open = !1, delete this.connection.active_streams[this.stream_id];
  }
}
class M {
  constructor(e, { wisp_version: t, wisp_extensions: s } = {}) {
    if (!e.endsWith("/"))
      throw new TypeError("wisp endpoints must end with a trailing forward slash");
    this.wisp_url = e, this.wisp_version = t || 2, this.wisp_extensions = s || null, this.max_buffer_size = null, this.active_streams = {}, this.connected = !1, this.connecting = !1, this.next_stream_id = 1, this.server_exts = {}, this.client_exts = {}, this.info_received = !1, this.server_motd = null, this.udp_enabled = !0, this.onopen = () => {
    }, this.onclose = () => {
    }, this.onerror = () => {
    }, this.onmessage = () => {
    }, this.wisp_version === 2 && this.wisp_extensions === null && this.add_extensions(), this.connect_ws();
  }
  add_extensions() {
    this.wisp_extensions = [], this.wisp_extensions.push(new z({ client_config: {} })), this.wisp_extensions.push(new y({ client_config: {} }));
  }
  connect_ws() {
    let e = this.wisp_version === 2 ? "wisp-v2" : void 0;
    this.ws = new L(this.wisp_url, e), this.ws.binaryType = "arraybuffer", this.connecting = !0, this.ws.onerror = () => {
      if (this.wisp_version === 2) {
        this.ws.onclose = null, this.cleanup(), this.wisp_version = 1, this.connect_ws();
        return;
      }
      this.cleanup(), this.onerror();
    }, this.ws.onclose = () => {
      this.cleanup(), this.onclose();
    }, this.ws.onmessage = (t) => {
      this.on_ws_msg(t), this.connected && this.connecting && (this.connecting = !1, this.onopen());
    };
  }
  close() {
    this.ws.close();
  }
  create_stream(e, t, s = 1) {
    let n = s;
    if (typeof n == "string" && (n = s === "udp" ? _.UDP : _.TCP), n == _.UDP && !this.udp_enabled)
      throw new Error("udp is not enabled for this wisp connection");
    let o = this.next_stream_id++, r = new H(e, t, this.ws, this.max_buffer_size, o, this, n);
    this.active_streams[o] = r, r.open = this.connected;
    let a = new f({
      type: u.CONNECT,
      stream_id: o,
      payload: new b({
        stream_type: n,
        port: t,
        hostname: e
      })
    });
    return this.ws.send(a.serialize().bytes), r;
  }
  close_stream(e, t) {
    e.onclose(t), delete this.active_streams[e.stream_id];
  }
  on_ws_msg(e) {
    let t = new h(new Uint8Array(e.data));
    if (t.size < f.min_size) {
      console.warn("wisp client warning: received a packet which is too short");
      return;
    }
    let s = f.parse_all(t), n = this.active_streams[s.stream_id];
    if (s.stream_id === 0 && this.connecting) {
      if (s.type === u.CONTINUE && (this.max_buffer_size = s.payload.buffer_remaining, this.connected = !0, this.info_received || (this.wisp_version = 1)), s.type === u.INFO && this.wisp_version === 2) {
        let o = O(s.payload.extensions, this.wisp_extensions, "server");
        for (let c of o)
          for (let d of this.wisp_extensions)
            c.id === d.id && (this.server_exts[c.id] = c, this.client_exts[d.id] = d);
        this.info_received = !0, this.server_motd = this.server_exts[y.id]?.payload?.message, this.udp_enabled = !!this.server_exts[z.id];
        let r = $(this.wisp_extensions), a = new f({
          type: w.type,
          stream_id: 0,
          payload: new w({
            major_ver: this.wisp_version,
            minor_ver: 0,
            extensions: r
          })
        });
        this.ws.send(a.serialize().bytes);
      }
      return;
    }
    if (typeof n > "u") {
      console.warn(`wisp client warning: received a ${C[s.type].name} packet for a stream which doesn't exist`);
      return;
    }
    s.type === u.DATA ? n.onmessage(s.payload_bytes.bytes) : s.type === u.CONTINUE ? n.continue_received(s.payload.buffer_remaining) : s.type === u.CLOSE ? this.close_stream(n, s.payload.reason) : console.warn(`wisp client warning: received an invalid packet of type ${s.type}`);
  }
  cleanup() {
    this.connected = !1, this.connecting = !1;
    for (let e of Object.keys(this.active_streams))
      this.close_stream(this.active_streams[e], 3);
  }
}
const j = 16, S = /* @__PURE__ */ new Map();
let F = 1;
const q = 16 * 1024 * 1024;
class ee {
  id = F++;
  #t = /* @__PURE__ */ new Map();
  #u = /* @__PURE__ */ new Map();
  // WASIX connects by resolved address. Retain its originating hostname so
  // WISP performs the remote connection without pinning traffic to one CDN IP.
  #w = /* @__PURE__ */ new Map();
  #c;
  #h;
  #r;
  #s;
  #e;
  #o;
  #a = 0;
  #m = 1;
  #d = () => !0;
  #i = !1;
  constructor(e, t = "https://cloudflare-dns.com/dns-query", s) {
    if (this.#r = e?.trim() || void 0, this.#h = s, this.#c = new URL(t, globalThis.location?.href), this.#c.protocol !== "https:" && this.#c.protocol !== "http:")
      throw new TypeError("WISP DNS endpoint must use http: or https:");
    S.set(this.id, this);
  }
  setWakeCallback(e) {
    this.#d = e;
  }
  setUrl(e) {
    if (this.#i)
      throw new Error("WISP network bridge is closed");
    this.#r = N(e).href, this.#a += 1;
    const t = this.#e, s = this.#s;
    this.#e = void 0, this.#s = void 0, this.#f(), t?.close(), s !== t && s?.close();
  }
  async resolve(e) {
    if (X(e))
      return [m(e)];
    const t = e.toLowerCase();
    if (t === "localhost")
      return ["127.0.0.1"];
    const s = this.#u.get(t);
    if (s && s.expiresAt > Date.now())
      return this.#_(t, s.addresses), [...s.addresses];
    await this.#p();
    const n = await B(this.#c, t);
    return this.#u.set(t, {
      addresses: n.addresses,
      expiresAt: Date.now() + n.ttlSeconds * 1e3
    }), this.#_(t, n.addresses), [...n.addresses];
  }
  async connectTcp(e, t) {
    if (this.#i)
      throw new Error("WISP network bridge is closed");
    const s = await this.#p(), n = J(t), o = this.#w.get(m(n.host)) ?? n.host, r = s.create_stream(o, n.port, "tcp"), a = this.#m++, c = {
      stream: r,
      chunks: [],
      offset: 0,
      buffered: 0,
      ended: !1
    };
    return this.#t.set(a, c), r.onmessage = (d) => {
      if (c.ended)
        return;
      const v = Uint8Array.from(d);
      if (c.buffered + v.byteLength > q) {
        c.ended = !0, r.close(3), this.#n(a, "error");
        return;
      }
      c.chunks.push(v), c.buffered += v.byteLength, this.#n(a, "readable");
    }, r.onclose = () => {
      c.ended = !0, this.#n(a, "close");
    }, queueMicrotask(() => this.#n(a, "writable")), {
      id: a,
      local: "0.0.0.0:0",
      peer: Q(n.host, n.port)
    };
  }
  socketRead(e, t) {
    const s = this.#t.get(e);
    if (!s)
      return null;
    if (s.buffered === 0)
      return s.ended ? null : void 0;
    const n = new Uint8Array(Math.min(t, s.buffered));
    let o = 0;
    for (; o < n.byteLength; ) {
      const r = s.chunks[0], a = Math.min(n.byteLength - o, r.byteLength - s.offset);
      n.set(r.subarray(s.offset, s.offset + a), o), o += a, s.offset += a, s.buffered -= a, s.offset === r.byteLength && (s.chunks.shift(), s.offset = 0);
    }
    return n;
  }
  socketWrite(e, t) {
    const s = this.#l(e);
    if (s.ended)
      throw new Error("WISP stream is closed");
    return s.stream.send(Uint8Array.from(t)), t.byteLength;
  }
  socketFlush(e) {
    return !this.#l(e).ended;
  }
  socketClose(e) {
    const t = this.#t.get(e);
    t && (t.ended = !0, t.stream.close(), this.#t.delete(e));
  }
  socketReadable(e) {
    const t = this.#t.get(e);
    return t ? t.buffered || (t.ended ? 0 : -1) : 0;
  }
  socketWritable(e) {
    const t = this.#t.get(e);
    return t && !t.ended ? 64 * 1024 : 0;
  }
  socketSetNoDelay(e, t) {
    this.#l(e);
  }
  socketSetKeepAlive(e, t) {
    this.#l(e);
  }
  socketRefresh(e) {
    queueMicrotask(() => {
      const t = this.#t.get(e);
      t && (t.buffered > 0 && this.#n(e, "readable"), t.ended ? this.#n(e, "close") : this.#n(e, "writable"));
    });
  }
  close() {
    this.#i || (this.#i = !0, S.delete(this.id), this.#f(), this.#e?.close(), this.#s?.close(), this.#e = void 0, this.#s = void 0, this.#d = () => !0);
  }
  async #p() {
    if (this.#i)
      throw new Error("WISP network bridge is closed");
    if (this.#s)
      return this.#s;
    if (this.#o)
      return this.#o;
    const e = this.#y();
    this.#o = e;
    try {
      return await e;
    } finally {
      this.#o === e && (this.#o = void 0);
    }
  }
  async #y() {
    let e = this.#r, t, s;
    for (; ; ) {
      if (!e) {
        if (!this.#h)
          throw s ?? new Error("No WISP endpoint is configured");
        const o = this.#a, r = await this.#h({
          url: t,
          error: s
        });
        if (o !== this.#a) {
          e = this.#r, t = void 0, s = void 0;
          continue;
        }
        e = r;
      }
      const n = this.#a;
      try {
        const o = N(e);
        return await this.#b(o);
      } catch (o) {
        if (this.#i)
          throw new Error("WISP network bridge is closed");
        if (n !== this.#a) {
          e = this.#r, t = void 0, s = void 0;
          continue;
        }
        if (s = G(o), t = e, e = void 0, !this.#h)
          throw s;
      }
    }
  }
  #b(e) {
    const t = new M(e.href);
    return this.#e = t, new Promise((s, n) => {
      let o = !1;
      const r = (a) => {
        o || (o = !0, this.#e === t && (this.#e = void 0), t.close(), n(a));
      };
      t.onopen = () => {
        if (this.#i || this.#e !== t) {
          r(new Error(this.#i ? "WISP network bridge is closed" : "WISP endpoint changed while connecting"));
          return;
        }
        o = !0, this.#e === t && (this.#e = void 0), this.#r = e.href, this.#s = t, s(t);
      }, t.onerror = () => {
        r(new Error(`WISP connection to ${e.href} failed`));
      }, t.onclose = () => {
        if (!o) {
          r(new Error(`WISP connection to ${e.href} closed before its handshake completed`));
          return;
        }
        this.#s === t && (this.#s = void 0), this.#f();
      };
    });
  }
  #l(e) {
    const t = this.#t.get(e);
    if (!t)
      throw new Error(`unknown WISP socket ${e}`);
    return t;
  }
  #f() {
    for (const [e, t] of this.#t)
      t.ended = !0, this.#n(e, "close");
  }
  #n(e, t) {
    this.#i || this.#d(e, t) || setTimeout(() => this.#n(e, t), 0);
  }
  #_(e, t) {
    for (const s of t)
      this.#w.set(m(s), e);
  }
}
async function B(i, e) {
  const t = await Promise.allSettled([
    I(i, e, 1),
    I(i, e, 28)
  ]), s = t.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  if (s.length === 0)
    throw t.find((a) => a.status === "rejected")?.reason ?? new Error(`DNS query for ${e} returned no addresses`);
  const n = [...new Set(s.map((r) => r.address))], o = Math.min(300, ...s.map((r) => r.ttlSeconds));
  return { addresses: n, ttlSeconds: o };
}
async function I(i, e, t) {
  const s = new URL(i);
  s.searchParams.set("name", e), s.searchParams.set("type", t === 1 ? "A" : "AAAA");
  const n = await fetch(s, {
    headers: { accept: "application/dns-json" }
  });
  if (!n.ok)
    throw new Error(`DNS query failed with HTTP ${n.status}`);
  const o = await n.json();
  if (o.Status !== 0)
    throw new Error(`DNS query for ${e} failed with status ${String(o.Status)}`);
  return (o.Answer ?? []).filter((r) => r.type === t && typeof r.data == "string" && (t === 1 ? W(r.data) : Z(r.data))).map((r) => ({
    address: r.data,
    ttlSeconds: typeof r.TTL == "number" && Number.isFinite(r.TTL) ? Math.max(1, r.TTL) : 60
  }));
}
function te() {
  const i = globalThis;
  i.__wasmerHostResolve = (e, t) => l(e).resolve(t), i.__wasmerHostConnectTcp = (e, t, s) => l(e).connectTcp(t, s), i.__wasmerHostSocketRead = (e, t, s) => l(e).socketRead(t, s), i.__wasmerHostSocketWrite = (e, t, s) => l(e).socketWrite(t, s), i.__wasmerHostSocketFlush = (e, t) => l(e).socketFlush(t), i.__wasmerHostSocketClose = (e, t) => l(e).socketClose(t), i.__wasmerHostSocketReadable = (e, t) => l(e).socketReadable(t), i.__wasmerHostSocketWritable = (e, t) => l(e).socketWritable(t), i.__wasmerHostSocketSetNoDelay = (e, t, s) => l(e).socketSetNoDelay(t, s), i.__wasmerHostSocketSetKeepAlive = (e, t, s) => l(e).socketSetKeepAlive(t, s), i.__wasmerHostSocketRefresh = (e, t) => l(e).socketRefresh(t), i.__wasmerHandleNetworkRpc = (e) => Y(e) ? (K(e), !0) : !1;
}
async function K(i) {
  const e = new Int32Array(i.response, 0, 4), t = new Uint8Array(i.response, j);
  try {
    const s = l(i.bridgeId), o = await s[i.method].apply(s, i.args);
    V(e, t, o);
  } catch (s) {
    console.error(`[wasmer-wisp] ${i.method} failed`, s), e[1] = 5, e[2] = A(t, String(s), !0);
  }
  Atomics.store(e, 0, 1), Atomics.notify(e, 0);
}
function V(i, e, t) {
  if (t === void 0)
    i[1] = 3;
  else if (t === null)
    i[1] = 4;
  else if (t instanceof Uint8Array) {
    if (t.byteLength > e.byteLength)
      throw new Error("WISP network response exceeds its worker mailbox");
    i[1] = 2, i[2] = t.byteLength, e.set(t);
  } else
    i[1] = 1, i[2] = A(e, JSON.stringify(t), !1);
}
function A(i, e, t) {
  const s = new TextEncoder().encode(e);
  if (!t && s.byteLength > i.byteLength)
    throw new Error("WISP network response exceeds its worker mailbox");
  const n = Math.min(s.byteLength, i.byteLength);
  return i.set(s.subarray(0, n)), n;
}
function l(i) {
  const e = S.get(i);
  if (!e)
    throw new Error(`unknown or closed WISP network bridge ${i}`);
  return e;
}
function Y(i) {
  return typeof i == "object" && i !== null && i.type === "wasmer-network-rpc";
}
function N(i) {
  const e = new URL(i, globalThis.location?.href);
  if (e.protocol !== "ws:" && e.protocol !== "wss:")
    throw new TypeError("WISP endpoint must use ws: or wss:");
  return e.pathname.endsWith("/") || (e.pathname += "/"), e;
}
function G(i) {
  return i instanceof Error ? i : new Error(String(i));
}
function J(i) {
  const e = /^\[([^\]]+)\]:(\d+)$/.exec(i);
  if (e)
    return { host: e[1], port: Number(e[2]) };
  const t = i.lastIndexOf(":");
  return {
    host: i.slice(0, t),
    port: Number(i.slice(t + 1))
  };
}
function Q(i, e) {
  return i.includes(":") ? `[${i}]:${e}` : `${i}:${e}`;
}
function m(i) {
  return i.startsWith("[") && i.endsWith("]") ? i.slice(1, -1) : i;
}
function X(i) {
  const e = m(i);
  return W(e) || e.includes(":");
}
function W(i) {
  const e = i.split(".");
  return e.length === 4 && e.every((t) => /^\d{1,3}$/.test(t) && Number(t) <= 255);
}
function Z(i) {
  return i.includes(":") && /^[0-9a-f:]+$/i.test(i);
}
export {
  ee as WispNetworkBridge,
  te as installWispNetworkGlobals
};
