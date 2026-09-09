const CHUNK_SIZE = 64 * 1024;
export const makeId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
export const MEMORY_LIMIT = 256 * 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TransferConnection {
  constructor({ signal, onState, onMessage, onTransfer, onError }) {
    Object.assign(this, { signal, onState, onMessage, onTransfer, onError });
    this.outgoing = new Map();
    this.incoming = new Map();
    this.sendQueue = Promise.resolve();
    this.receiveQueue = Promise.resolve();
    this.closed = false;
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.candidates = [];
    this.pc.onicecandidate = (e) => {
      if (e.candidate) signal({ candidate: e.candidate });
    };
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (
        this.pc.connectionState === "connected" &&
        this.channel?.readyState === "open"
      )
        onState("connected");
      if (this.pc.connectionState === "disconnected") onState("disconnected");
      if (this.pc.connectionState === "failed") {
        this.close();
        onState("failed");
      }
    };
    this.connectionTimer = setTimeout(() => {
      if (!this.closed && this.channel?.readyState !== "open")
        onState("failed");
    }, 25000);
  }
  async start() {
    this.attach(this.pc.createDataChannel("landrop", { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ description: this.pc.localDescription });
  }
  async handleSignal(data) {
    if (this.closed) return;
    if (data.description) {
      await this.pc.setRemoteDescription(data.description);
      for (const candidate of this.candidates)
        await this.pc.addIceCandidate(candidate);
      this.candidates = [];
      if (data.description.type === "offer") {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal({ description: this.pc.localDescription });
      }
    } else if (data.candidate) {
      if (this.pc.remoteDescription)
        await this.pc.addIceCandidate(data.candidate);
      else this.candidates.push(data.candidate);
    }
  }
  attach(channel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      clearTimeout(this.connectionTimer);
      this.onState("connected");
    };
    channel.onclose = () => {
      if (!this.closed) this.onState("disconnected");
    };
    channel.onerror = () => {
      if (!this.closed) this.onError("传输连接发生错误，请重新连接。");
    };
    channel.onmessage = (e) => {
      this.receiveQueue = this.receiveQueue
        .then(() => this.receive(e.data))
        .catch((error) => {
          if (this.activeReceive) this.cancel(this.activeReceive, "保存失败");
          this.onError(`接收失败：${error.message}`);
        });
    };
  }
  send(data) {
    if (this.closed || this.channel?.readyState !== "open")
      throw new Error("设备尚未连接");
    this.channel.send(JSON.stringify(data));
  }
  text(text) {
    this.send({ type: "text", text, id: makeId() });
  }
  offer(files) {
    for (const file of files) {
      const id = makeId();
      this.outgoing.set(id, { file, cancelled: false });
      this.onTransfer({
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
        direction: "out",
        status: "offered",
        progress: 0,
      });
      this.send({
        type: "offer",
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
      });
    }
  }
  async accept(id, writable = null) {
    const entry = this.incoming.get(id);
    if (!entry || entry.accepted) {
      await writable?.abort();
      return;
    }
    if (this.closed) {
      await writable?.abort();
      throw new Error("连接已断开");
    }
    if (!writable && entry.size > MEMORY_LIMIT)
      throw new Error(
        "当前浏览器单文件接收上限为 256 MB，请使用桌面 Chrome / Edge 并通过 localhost 或 HTTPS 打开以直接写入磁盘。",
      );
    const allocated = [...this.incoming.values()].reduce(
      (sum, item) => sum + (item.accepted && !item.writable ? item.size : 0),
      0,
    );
    if (!writable && allocated + entry.size > MEMORY_LIMIT)
      throw new Error(
        "同时接收的文件超过内存上限，请等待当前文件完成后再接收。",
      );
    Object.assign(entry, {
      writable,
      chunks: [],
      accepted: true,
      received: 0,
      started: performance.now(),
      lastUpdate: 0,
    });
    this.onTransfer({ id, status: "queued" });
    this.send({ type: "accept", id });
  }
  cancel(id, reason = "已取消") {
    const out = this.outgoing.get(id);
    if (out) {
      out.cancelled = true;
      this.outgoing.delete(id);
    }
    const entry = this.incoming.get(id);
    if (entry) {
      entry.writable?.abort().catch(() => {});
      this.incoming.delete(id);
    }
    this.onTransfer({ id, status: "cancelled", detail: reason });
    try {
      this.send({ type: "cancel", id });
    } catch {}
  }
  async receive(raw) {
    if (this.closed) return;
    if (raw instanceof ArrayBuffer) {
      const entry = this.incoming.get(this.activeReceive);
      if (!entry?.accepted) return;
      if (entry.received + raw.byteLength > entry.size)
        throw new Error("文件大小校验失败");
      if (entry.writable) await entry.writable.write(raw);
      else entry.chunks.push(raw);
      entry.received += raw.byteLength;
      const now = performance.now();
      if (now - entry.lastUpdate > 100 || entry.received === entry.size) {
        entry.lastUpdate = now;
        this.onTransfer({
          id: this.activeReceive,
          status: "transferring",
          progress: entry.size ? entry.received / entry.size : 1,
          speed: entry.received / Math.max((now - entry.started) / 1000, 0.01),
        });
      }
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (
      data.type === "text" &&
      typeof data.text === "string" &&
      data.text.length <= 20000
    ) {
      this.onMessage({
        id: makeId(),
        text: data.text,
        direction: "in",
        time: Date.now(),
      });
    } else if (data.type === "offer") {
      if (
        typeof data.id !== "string" ||
        data.id.length > 64 ||
        this.incoming.has(data.id) ||
        typeof data.name !== "string" ||
        !Number.isSafeInteger(data.size) ||
        data.size < 0 ||
        this.incoming.size >= 100
      )
        return;
      const entry = {
        id: data.id,
        name: data.name.slice(0, 255),
        size: data.size,
        mime: typeof data.mime === "string" ? data.mime.slice(0, 100) : "",
      };
      this.incoming.set(data.id, entry);
      this.onTransfer({
        ...entry,
        direction: "in",
        status: "offered",
        progress: 0,
      });
    } else if (data.type === "accept") {
      const entry = this.outgoing.get(data.id);
      if (entry && !entry.accepted) {
        entry.accepted = true;
        this.onTransfer({ id: data.id, status: "queued" });
        this.sendQueue = this.sendQueue
          .then(() => this.sendFile(data.id))
          .catch((error) => {
            if (!this.closed) {
              this.cancel(data.id, "传输失败");
              this.onError(error.message);
            }
          });
      }
    } else if (data.type === "start") {
      if (!this.incoming.get(data.id)?.accepted) return;
      this.activeReceive = data.id;
      this.incoming.get(data.id).started = performance.now();
      this.onTransfer({ id: data.id, status: "transferring" });
    } else if (data.type === "end") {
      const entry = this.incoming.get(data.id);
      if (!entry?.accepted) return;
      if (entry.received !== entry.size)
        throw new Error("文件不完整，请重新发送");
      let url;
      if (entry.writable) await entry.writable.close();
      else
        url = URL.createObjectURL(
          new Blob(entry.chunks, { type: "application/octet-stream" }),
        );
      this.onTransfer({
        id: data.id,
        status: "complete",
        progress: 1,
        url,
        saved: !!entry.writable,
      });
      this.incoming.delete(data.id);
      this.activeReceive = null;
      this.send({ type: "complete", id: data.id });
    } else if (data.type === "complete" && this.outgoing.has(data.id)) {
      this.onTransfer({ id: data.id, status: "complete", progress: 1 });
      this.outgoing.delete(data.id);
    } else if (data.type === "cancel") {
      const entry = this.outgoing.get(data.id) || this.incoming.get(data.id);
      if (entry) {
        entry.cancelled = true;
        await entry.writable?.abort();
        this.outgoing.delete(data.id);
        this.incoming.delete(data.id);
        this.onTransfer({
          id: data.id,
          status: "cancelled",
          detail: "对方已取消",
        });
      }
    }
  }
  async sendFile(id) {
    const entry = this.outgoing.get(id);
    if (!entry || entry.cancelled || this.closed) return;
    this.send({ type: "start", id });
    const started = performance.now();
    let lastUpdate = 0;
    for (let offset = 0; offset < entry.file.size; offset += CHUNK_SIZE) {
      while (this.channel.bufferedAmount > 1024 * 1024) {
        if (this.closed || entry.cancelled) return;
        if (this.channel.readyState !== "open") throw new Error("连接已断开");
        await wait(15);
      }
      if (entry.cancelled || this.closed) return;
      const chunk = await entry.file
        .slice(offset, offset + CHUNK_SIZE)
        .arrayBuffer();
      if (entry.cancelled || this.closed) return;
      this.channel.send(chunk);
      const sent = Math.min(offset + CHUNK_SIZE, entry.file.size);
      const now = performance.now();
      if (now - lastUpdate > 100 || sent === entry.file.size) {
        lastUpdate = now;
        this.onTransfer({
          id,
          status: "transferring",
          progress: sent / entry.file.size,
          speed: sent / Math.max((now - started) / 1000, 0.01),
        });
      }
    }
    if (!entry.cancelled && !this.closed) {
      this.send({ type: "end", id });
      this.onTransfer({ id, status: "verifying", progress: 1 });
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.connectionTimer);
    for (const [id, entry] of this.outgoing) {
      entry.cancelled = true;
      this.onTransfer({ id, status: "cancelled", detail: "连接已断开" });
    }
    for (const [id, entry] of this.incoming) {
      entry.writable?.abort().catch(() => {});
      this.onTransfer({ id, status: "cancelled", detail: "连接已断开" });
    }
    this.outgoing.clear();
    this.incoming.clear();
    this.channel?.close();
    this.pc.close();
  }
}
