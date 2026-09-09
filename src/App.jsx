import React, { useEffect, useRef, useState } from "react";
import {
  Wifi,
  ArrowUpRight,
  Plus,
  Laptop,
  Smartphone,
  ShieldCheck,
  Zap,
  Link2,
  Copy,
  Check,
  X,
  Send,
  Paperclip,
  Download,
  File,
  FileText,
  Image,
  FolderUp,
  CircleHelp,
  ChevronDown,
  CheckCheck,
  RefreshCw,
  Clock3,
} from "lucide-react";
import QRCode from "qrcode";
import { TransferConnection, MEMORY_LIMIT, makeId } from "./transfer";

const formatSize = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const deviceName = isMobile
  ? "移动设备"
  : /Windows/i.test(navigator.userAgent)
    ? "Windows 电脑"
    : /Mac/i.test(navigator.userAgent)
      ? "Mac 电脑"
      : "当前电脑";
const timeLabel = (time) =>
  new Date(time).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const initialCode = new URLSearchParams(location.search).get("connect") || "";

export default function App() {
  const [room, setRoom] = useState("");
  const [phase, setPhase] = useState("idle");
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [network, setNetwork] = useState({ interfaces: [], clientIp: "" });
  const [shareHost, setShareHost] = useState(location.hostname);
  const [peer, setPeer] = useState(null);
  const [qr, setQr] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState(null);
  const [messages, setMessages] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const socket = useRef(null);
  const connection = useRef(null);
  const fileInput = useRef(null);
  const feed = useRef(null);
  const transferRef = useRef([]);
  const autoJoined = useRef(false);
  const connectedOnce = useRef(false);
  const actionTimer = useRef(null);
  const [receivingIds, setReceivingIds] = useState(new Set());
  const modalRef = useRef(null);
  const connected = phase === "connected";
  const showTransfer = connected || connectedOnce.current;
  const shareUrl = `${location.protocol}//${shareHost}${location.port ? `:${location.port}` : ""}/?connect=${room}`;
  const updateTransfer = (patch) =>
    setTransfers((prev) => {
      const exists = prev.some((t) => t.id === patch.id);
      if (!exists && !patch.name) return prev;
      const next = exists
        ? prev.map((t) => (t.id === patch.id ? { ...t, ...patch } : t))
        : [...prev, { ...patch, time: Date.now() }];
      transferRef.current = next;
      return next;
    });
  const notify = (text) => setToast(text);
  const sendSignal = (data) => {
    if (socket.current?.readyState !== WebSocket.OPEN)
      throw new Error("传输服务尚未连接，请稍后重试。");
    socket.current.send(JSON.stringify(data));
  };
  const resetConnection = () => {
    connection.current?.close();
    connection.current = null;
    setPeer(null);
  };

  useEffect(() => {
    fetch("/api/network")
      .then((r) => r.json())
      .then((data) => {
        setNetwork(data);
        if (
          ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
          data.interfaces.length
        ) {
          const preferred =
            data.interfaces.find(
              (i) => !/vEthernet|Virtual|VMware|VPN|WSL|Docker/i.test(i.name),
            ) || data.interfaces[0];
          setShareHost(preferred.ip);
        }
      })
      .catch(() => setError("无法读取网络信息，请确认传输服务正在运行。"));
    let stopped = false;
    let retry;
    function connectSocket() {
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`,
      );
      socket.current = ws;
      ws.onopen = () => {
        if (stopped) return;
        setOnline(true);
        if (!autoJoined.current) {
          autoJoined.current = true;
          setBusy(true);
          ws.send(
            JSON.stringify({
              type: initialCode && location.search ? "join" : "create",
              code: initialCode,
              device: isMobile ? "mobile" : "desktop",
            }),
          );
        }
      };
      ws.onmessage = async (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (stopped) return;
        if (["room", "error", "left", "expired"].includes(data.type)) {
          clearTimeout(actionTimer.current);
          setBusy(false);
        }
        if (data.type === "room") {
          setRoom(data.code);
          setPhase("waiting");
          setError("");
        } else if (data.type === "peer-joined") {
          resetConnection();
          setPeer({ ip: data.ip, device: data.device });
          setPhase("connecting");
          try {
            const transport = new TransferConnection({
              signal: (signal) => sendSignal({ type: "signal", signal }),
              onState: (state) => {
                if (state === "connected") {
                  connectedOnce.current = true;
                  setError("");
                }
                if (state === "failed")
                  setError(
                    "直连未成功。请确认两台设备连接同一 Wi-Fi，且路由器未开启 AP 隔离，然后刷新二维码重试。",
                  );
                setPhase(state);
              },
              onMessage: (message) => setMessages((prev) => [...prev, message]),
              onTransfer: updateTransfer,
              onError: (message) => setError(message),
            });
            connection.current = transport;
            if (data.initiator) await transport.start();
          } catch {
            setPhase("failed");
            setError(
              "当前浏览器无法建立 WebRTC 连接，请使用新版 Chrome、Edge 或 Safari。",
            );
          }
        } else if (data.type === "signal") {
          try {
            await connection.current?.handleSignal(data.signal);
          } catch {
            setError("建立连接失败，请刷新二维码后重试。");
            setPhase("failed");
          }
        } else if (data.type === "peer-left") {
          resetConnection();
          setPhase("waiting");
          connectedOnce.current = false;
          notify("对方已断开，重新扫码即可连接。");
        } else if (data.type === "left" || data.type === "expired") {
          resetConnection();
          setRoom("");
          setPhase("idle");
          connectedOnce.current = false;
          if (data.type === "expired") {
            notify("二维码已刷新");
            ws.send(
              JSON.stringify({
                type: "create",
                device: isMobile ? "mobile" : "desktop",
              }),
            );
          }
        } else if (data.type === "error") {
          setError(data.message);
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setOnline(false);
        setBusy(false);
        resetConnection();
        setRoom("");
        setPhase("idle");
        connectedOnce.current = false;
        autoJoined.current = false;
        setError(
          location.protocol === "https:"
            ? "WebSocket 安全连接已断开，正在重连；部署环境请检查反向代理是否已转发 /signal 的 Upgrade 请求。"
            : "与传输服务的连接已断开，正在自动重连…",
        );
        retry = setTimeout(connectSocket, 2000);
      };
      ws.onerror = () => {};
    }
    connectSocket();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(actionTimer.current);
      socket.current?.close();
      connection.current?.close();
      for (const t of transferRef.current)
        if (t.url) URL.revokeObjectURL(t.url);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    if (room) {
      let valid = true;
      QRCode.toDataURL(shareUrl, {
        width: 224,
        margin: 1,
        color: { dark: "#163b3b", light: "#ffffff" },
      })
        .then((url) => {
          if (valid) setQr(url);
        })
        .catch(() =>
          setError("二维码生成失败，请复制连接链接到另一台设备打开。"),
        );
      return () => {
        valid = false;
      };
    }
  }, [shareUrl, room]);
  useEffect(() => {
    feed.current?.scrollTo({
      top: feed.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, transfers.length, connected]);

  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement;
    const trapFocus = (event) => {
      if (event.key === "Escape") {
        setModal(null);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = [
        ...modalRef.current.querySelectorAll(
          "button:not(:disabled), a[href], input, select",
        ),
      ];
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      previous?.focus();
    };
  }, [modal]);

  function roomAction(type) {
    setError("");
    try {
      sendSignal({ type, device: isMobile ? "mobile" : "desktop" });
      setBusy(true);
      clearTimeout(actionTimer.current);
      actionTimer.current = setTimeout(() => {
        setBusy(false);
        setError("操作超时，请检查连接后重试。");
      }, 10000);
    } catch (e) {
      setError(e.message);
    }
  }
  function leaveRoom() {
    try {
      sendSignal({ type: "leave" });
    } catch {}
    resetConnection();
    setRoom("");
    setPhase("idle");
    setModal(null);
    setError("");
    connectedOnce.current = false;
    setMessages([]);
    setDraft("");
    // Keep completed files accessible in this tab's transfer history.
    history.replaceState(null, "", location.pathname);
    autoJoined.current = true;
    roomAction("create");
  }
  async function copy(text) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        const success = document.execCommand("copy");
        input.remove();
        if (!success) throw new Error();
      }
      notify("已复制到剪贴板");
    } catch {
      setError("无法自动复制，请手动选择并复制内容。");
    }
  }
  function sendText() {
    if (!draft.trim() || !connected) return;
    try {
      connection.current.text(draft.trim());
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          text: draft.trim(),
          direction: "out",
          time: Date.now(),
        },
      ]);
      setDraft("");
    } catch (e) {
      setError(e.message);
    }
  }
  function addFiles(files) {
    if (!files?.length) return;
    if (!connected) {
      notify("请先连接另一台设备，再添加文件。");
      return;
    }
    if (files.length > 30) {
      setError("每次最多选择 30 个文件，请分批发送。");
      return;
    }
    try {
      connection.current.offer(Array.from(files));
    } catch (e) {
      setError(e.message);
    }
  }
  async function acceptFile(t) {
    if (receivingIds.has(t.id)) return;
    setReceivingIds((prev) => new Set(prev).add(t.id));
    try {
      let writable;
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: t.name.replace(/[\\/]/g, "_"),
        });
        writable = await handle.createWritable();
      }
      await connection.current.accept(t.id, writable);
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setReceivingIds((prev) => {
        const next = new Set(prev);
        next.delete(t.id);
        return next;
      });
    }
  }
  const allItems = [
    ...messages.map((m) => ({ ...m, kind: "text" })),
    ...transfers.map((t) => ({ ...t, kind: "file" })),
  ].sort((a, b) => a.time - b.time);
  const completed = transfers.filter((t) => t.status === "complete");

  function fileCard(t, compact = false) {
    const Icon = t.mime?.startsWith("image/")
      ? Image
      : /text|pdf/.test(t.mime)
        ? FileText
        : File;
    const status = {
      offered: t.direction === "out" ? "等待对方接收" : "等待你接收",
      queued: "已就绪，等待传输",
      transferring: "正在传输",
      verifying: "等待接收端确认",
      complete:
        t.direction === "out"
          ? "已发送"
          : t.saved
            ? "已保存到本地"
            : "接收完成，待保存",
      cancelled: t.detail || "已取消",
    }[t.status];
    return (
      <div className={`file-card ${t.direction}`} key={t.id}>
        <div className="file-top">
          <span
            className={`file-icon ${t.mime?.startsWith("image/") ? "purple" : ""}`}
          >
            <Icon size={22} />
          </span>
          <div className="file-name">
            <strong title={t.name}>{t.name}</strong>
            <span>
              {formatSize(t.size)} <i>·</i>{" "}
              {t.direction === "out" ? "发送文件" : "接收文件"}
            </span>
          </div>
          {t.status === "complete" && <CheckCheck size={18} className="teal" />}
        </div>
        {!compact && (
          <div className="file-progress">
            <div className="progress-track">
              <span
                style={{ width: `${Math.round((t.progress || 0) * 100)}%` }}
              />
            </div>
            <div className="progress-caption">
              <span>{status}</span>
              <span>
                {t.status === "transferring"
                  ? `${formatSize(Math.round(t.speed || 0))}/s · ${Math.round(t.progress * 100)}%`
                  : ""}
              </span>
            </div>
          </div>
        )}
        {compact && (
          <p className="compact-status">
            {status} · {timeLabel(t.time)}
          </p>
        )}
        <div className="file-actions">
          {t.direction === "in" && t.status === "offered" && (
            <>
              <button
                className="text-button muted"
                onClick={() => connection.current?.cancel(t.id)}
              >
                拒绝
              </button>
              <button
                className="mini-primary"
                disabled={!connected || receivingIds.has(t.id)}
                onClick={() => acceptFile(t)}
              >
                <Download size={14} />
                {receivingIds.has(t.id) ? "选择保存位置…" : "保存并接收"}
              </button>
            </>
          )}
          {["offered", "queued", "transferring", "verifying"].includes(
            t.status,
          ) &&
            !(t.direction === "in" && t.status === "offered") && (
              <button
                className="text-button muted"
                onClick={() => connection.current?.cancel(t.id)}
              >
                取消传输
              </button>
            )}
          {t.url && (
            <a className="mini-primary" href={t.url} download={t.name}>
              <Download size={14} />
              保存文件
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (room) setModal("leave");
          }}
        >
          <span className="brand-icon">
            <Wifi size={25} strokeWidth={2.2} />
          </span>
          <span>
            轻传<span className="brand-en">LAN DROP</span>
          </span>
        </a>
        <nav aria-label="主导航">
          <button className="nav-item active" onClick={() => setModal(null)}>
            文件快传
          </button>
          <button className="nav-item" onClick={() => setModal("history")}>
            传输记录
            {completed.length > 0 && (
              <span className="nav-count">{completed.length}</span>
            )}
          </button>
        </nav>
        <button
          aria-label="使用帮助"
          className="help-button"
          onClick={() => setModal("help")}
        >
          <CircleHelp size={17} />
          <span>使用帮助</span>
        </button>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow">
            <span className="tiny-dot" /> 同一网络，即刻相连
          </div>
          <h1>
            让文件，在设备间<span>自由流动。</span>
          </h1>
          <p>同一个 Wi-Fi，扫一扫就连接。无需登录，让分享更简单。</p>
        </section>

        <section
          className={`workspace ${showTransfer ? "transfer-workspace" : ""}`}
        >
          <div className="workspace-heading">
            <div className="heading-label">
              <Wifi size={18} />
              <h2>局域网文件快传</h2>
            </div>
            <span className={`network-status ${!online ? "offline" : ""}`}>
              <span className="tiny-dot" />
              {online
                ? connected
                  ? "设备已直连"
                  : "本地服务在线"
                : "正在连接服务"}
            </span>
          </div>
          <div className="workspace-body">
            <aside className="device-panel">
              <div className="section-label">我的设备</div>
              <div className="device-illustration">
                <div className="device-orbit" />
                <span className="device-monitor">
                  {isMobile ? (
                    <Smartphone size={40} strokeWidth={1.5} />
                  ) : (
                    <Laptop size={48} strokeWidth={1.4} />
                  )}
                </span>
                <span className="device-check">
                  <Check size={11} strokeWidth={3} />
                </span>
              </div>
              <h3>{deviceName}</h3>
              <span className="device-tag">本机</span>
              <div className="device-info">
                <span>局域网 IP</span>
                <strong>
                  {network.clientIp &&
                  !["127.0.0.1", "::1"].includes(network.clientIp)
                    ? network.clientIp
                    : shareHost === "localhost"
                      ? "正在获取…"
                      : shareHost}
                </strong>
              </div>
              <div className="device-info">
                <span>连接方式</span>
                <strong>
                  <Wifi size={13} />
                  局域网直连
                </strong>
              </div>
              {peer ? (
                <div className="peer-device">
                  <span className="peer-icon">
                    {peer.device === "mobile" ? (
                      <Smartphone size={20} />
                    ) : (
                      <Laptop size={21} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {peer.device === "mobile"
                        ? "对方的移动设备"
                        : "对方的电脑"}
                    </strong>
                    <small>{peer.ip}</small>
                  </div>
                  <span className="tiny-dot" />
                </div>
              ) : (
                <div className="device-hint">
                  <span className="hint-line" />
                  <span className="hint-icon">
                    <Plus size={17} />
                  </span>
                  <p>另一台设备，等你连接</p>
                </div>
              )}
              <div className="privacy-note">
                <ShieldCheck size={17} />
                <p>
                  文件仅在设备间传输
                  <br />
                  <span>不经过云端，不留存文件</span>
                </p>
              </div>
            </aside>

            <div className="main-panel">
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    aria-label="关闭错误提示"
                    onClick={() => setError("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {!showTransfer ? (
                <div className="scan-panel">
                  <div className="scan-heading">
                    <span className="scan-eyebrow">
                      <span className="tiny-dot" />
                      扫码即连 · 双向传输
                    </span>
                    <h2>
                      {phase === "connecting"
                        ? "正在连接你的设备…"
                        : phase === "failed"
                          ? "暂时无法连接"
                          : "扫一扫，把文件传过来"}
                    </h2>
                    <p>
                      {phase === "connecting"
                        ? "已找到设备，正在建立加密直连"
                        : "用另一台设备的相机扫描下方二维码"}
                    </p>
                  </div>
                  <div className="qr-scene">
                    <span className="floating-device floating-laptop">
                      <Laptop size={26} strokeWidth={1.5} />
                    </span>
                    <span className="floating-device floating-phone">
                      <Smartphone size={24} strokeWidth={1.5} />
                    </span>
                    <span className="scene-dots left-dots" />
                    <span className="scene-dots right-dots" />
                    <div className="qr-frame">
                      <span className="qr-corner top-left" />
                      <span className="qr-corner top-right" />
                      <span className="qr-corner bottom-left" />
                      <span className="qr-corner bottom-right" />
                      {qr && room ? (
                        <img className="qr-image" src={qr} alt="扫码连接设备" />
                      ) : (
                        <div className="qr-loading">
                          <RefreshCw size={28} className="spin" />
                          <span>正在生成二维码…</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="scan-status">
                    <span
                      className={
                        phase === "connecting" ? "pulse-dot" : "tiny-dot"
                      }
                    />
                    {phase === "connecting"
                      ? "正在建立连接"
                      : "等待另一台设备扫码"}
                  </div>
                  <div className="scan-actions">
                    <button
                      className="secondary"
                      disabled={!room}
                      onClick={() => copy(shareUrl)}
                    >
                      <Link2 size={15} />
                      复制连接链接
                    </button>
                    <button
                      className="text-button muted"
                      disabled={!online || busy}
                      onClick={() => {
                        leaveRoom();
                        notify("二维码已刷新");
                      }}
                    >
                      <RefreshCw size={14} />
                      刷新二维码
                    </button>
                  </div>
                  {network.interfaces.length > 1 && (
                    <label className="network-select">
                      网络地址
                      <select
                        value={shareHost}
                        onChange={(e) => setShareHost(e.target.value)}
                      >
                        {!network.interfaces.some(
                          (i) => i.ip === shareHost,
                        ) && <option value={shareHost}>{shareHost}</option>}
                        {network.interfaces.map((i) => (
                          <option key={i.ip} value={i.ip}>
                            {i.ip} · {i.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} />
                    </label>
                  )}
                  <div className="same-network-note">
                    <Wifi size={16} />
                    <span>请确保两台设备连接同一个 Wi-Fi 或局域网</span>
                  </div>
                </div>
              ) : (
                <div
                  className="chat"
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (connected) setDragging(true);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget))
                      setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    addFiles(e.dataTransfer.files);
                  }}
                >
                  <div
                    className={`connection-bar ${!connected ? "pending" : ""}`}
                  >
                    <div>
                      <span className="tiny-dot" />
                      <strong>
                        {connected
                          ? "已建立直连"
                          : phase === "connecting"
                            ? "正在重新连接"
                            : phase === "waiting"
                              ? "等待对方重新连接"
                              : "连接已中断"}
                      </strong>
                      <span className="connection-detail">局域网加密传输</span>
                    </div>
                    <button onClick={() => setModal("leave")}>
                      断开连接
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                  <div className="chat-feed" ref={feed}>
                    {allItems.length === 0 ? (
                      <div className="chat-empty">
                        <span>
                          <Wifi size={29} />
                        </span>
                        <h3>设备已连接，开始分享吧</h3>
                        <p>
                          拖入文件，或发送一句话
                          <br />
                          你的下一次传输，从这里开始
                        </p>
                        <button
                          className="secondary"
                          disabled={!connected}
                          onClick={() => fileInput.current.click()}
                        >
                          <Plus size={15} />
                          选择文件
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="feed-date">
                          本次会话 ·{" "}
                          {new Date().toLocaleDateString("zh-CN", {
                            month: "long",
                            day: "numeric",
                          })}
                        </div>
                        {allItems.map((item) => (
                          <div
                            className={`message-row ${item.direction}`}
                            key={item.id}
                          >
                            <div className="message-meta">
                              {item.direction === "out" ? "我" : "对方"}
                              <span>{timeLabel(item.time)}</span>
                            </div>
                            {item.kind === "file" ? (
                              fileCard(item)
                            ) : (
                              <div className="text-message">
                                <p>{item.text}</p>
                                <button
                                  aria-label="复制消息"
                                  onClick={() => copy(item.text)}
                                >
                                  <Copy size={13} />
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="composer">
                    <textarea
                      aria-label="输入消息"
                      placeholder={
                        connected
                          ? "输入消息，或将文件拖到这里…"
                          : "等待设备连接后继续发送…"
                      }
                      value={draft}
                      maxLength={20000}
                      disabled={!connected}
                      onChange={(e) => setDraft(e.target.value)}
                      onPaste={(e) => {
                        if (e.clipboardData.files.length) {
                          e.preventDefault();
                          addFiles(e.clipboardData.files);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          sendText();
                        }
                      }}
                    />
                    <div className="composer-actions">
                      <button
                        className="attachment-button"
                        disabled={!connected}
                        onClick={() => fileInput.current.click()}
                      >
                        <Paperclip size={17} />
                        添加文件
                      </button>
                      <span className="keyboard-hint">
                        Enter 发送 · Shift + Enter 换行
                      </span>
                      <button
                        className="primary send-button"
                        disabled={!connected || !draft.trim()}
                        onClick={sendText}
                      >
                        <Send size={15} />
                        发送
                      </button>
                    </div>
                  </div>
                  {dragging && (
                    <div className="drop-overlay">
                      <FolderUp size={48} />
                      <h3>松开鼠标，添加文件</h3>
                      <p>对方确认后开始传输</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              WebRTC 加密传输
            </span>
            <span>
              <span className="tiny-dot" />
              无需安装 · 跨平台使用
            </span>
          </div>
        </section>

        <section className="benefits">
          <div>
            <span className="benefit-icon">
              <Zap size={21} />
            </span>
            <div>
              <h3>快一点，再快一点</h3>
              <p>利用局域网带宽，文件无需绕行云端</p>
            </div>
          </div>
          <div>
            <span className="benefit-icon">
              <ShieldCheck size={21} />
            </span>
            <div>
              <h3>你的文件，只属于你</h3>
              <p>点对点加密传输，服务器不存储文件</p>
            </div>
          </div>
          <div>
            <span className="benefit-icon">
              <Laptop size={21} />
            </span>
            <div>
              <h3>不同设备，一样轻松</h3>
              <p>电脑、手机、平板，打开浏览器就能用</p>
            </div>
          </div>
        </section>
        <footer className="footer">
          <span className="footer-brand">
            <Wifi size={15} />
            轻传<span>让分享回归简单</span>
          </span>
          <span>
            本地连接 · 自由分享<span className="footer-dot">·</span>
            <button onClick={() => setModal("help")}>
              使用指南
              <ArrowUpRight size={12} />
            </button>
          </span>
        </footer>
      </main>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        multiple
        aria-label="选择待传输文件"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setModal(null);
          }}
        >
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close"
              autoFocus
              aria-label="关闭弹窗"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            {modal === "help" ? (
              <>
                <span className="modal-symbol">
                  <CircleHelp size={25} />
                </span>
                <h2 id="modal-title">分享，其实很简单</h2>
                <p className="modal-intro">扫一扫，文件就能在设备间传递。</p>
                <ol className="help-steps">
                  <li>
                    <span>01</span>
                    <div>
                      <h3>连接同一个网络</h3>
                      <p>
                        电脑和手机连接同一
                        Wi-Fi，或同一路由器。由一台电脑运行轻传服务，两台设备都打开该电脑的局域网地址。
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <h3>打开相机，扫一扫</h3>
                      <p>
                        打开页面就会自动生成二维码。用另一台设备的相机扫码，在浏览器打开链接，设备会自动连接。也可以复制连接链接，在另一台设备打开。
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <h3>选择文件，轻松发送</h3>
                      <p>
                        连接后拖入文件或点击「添加文件」，对方点击「保存并接收」。还可以发送文字和粘贴图片。
                      </p>
                    </div>
                  </li>
                </ol>
                <div className="help-tip">
                  <strong>连接遇到问题？</strong>
                  <p>
                    检查网络是否相同，Windows 防火墙是否允许 Node.js
                    的专用网络连接，以及路由器是否开启访客网络或 AP 隔离。
                  </p>
                  <p>
                    支持直接写入磁盘的浏览器可接收大文件；其他浏览器使用内存接收，单文件上限{" "}
                    {formatSize(MEMORY_LIMIT)}
                    ，完成后请点击「保存文件」。刷新页面会清空会话和未保存的文件。等待
                    30 分钟后二维码会自动刷新。
                  </p>
                </div>
                <button
                  className="primary full-width"
                  onClick={() => setModal(null)}
                >
                  知道了
                  <Check size={16} />
                </button>
              </>
            ) : modal === "history" ? (
              <>
                <span className="modal-symbol">
                  <Clock3 size={25} />
                </span>
                <h2 id="modal-title">传输记录</h2>
                <p className="modal-intro">
                  当前页面的文件记录，刷新或关闭后清空。
                </p>
                <div className="history-list">
                  {transfers.length ? (
                    [...transfers].reverse().map((t) => fileCard(t, true))
                  ) : (
                    <div className="history-empty">
                      <FolderUp size={38} strokeWidth={1.3} />
                      <h3>还没有传输记录</h3>
                      <p>连接设备，发送你的第一个文件吧。</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <span className="modal-symbol">
                  <Link2 size={25} />
                </span>
                <h2 id="modal-title">断开设备连接？</h2>
                <p className="modal-intro">
                  正在传输的文件会被取消。已接收的文件仍可在传输记录中保存。
                </p>
                <div className="modal-actions">
                  <button className="secondary" onClick={() => setModal(null)}>
                    继续传输
                  </button>
                  <button className="primary" onClick={leaveRoom}>
                    断开连接
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
