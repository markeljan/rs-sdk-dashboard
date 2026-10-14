import { FormEvent, useEffect, useRef, useState } from "react";

type Message = { id: number; at: number; name: string; text: string };
export function ChatPanel() {
    const [name, setName] = useState(() => { try { return localStorage.getItem('rs-tv.nickname') ?? `Guest${Math.floor(Math.random()*9000+1000)}`; } catch { return 'Guest'; } });
    const [text, setText] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState('');
    const socket = useRef<WebSocket>();
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => { try { localStorage.setItem('rs-tv.nickname', name); } catch { /* storage unavailable */ } }, [name]);
    useEffect(() => {
        let stopped = false; let retry: ReturnType<typeof setTimeout>;
        const open = () => {
            const ws = socket.current = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/chat`);
            ws.onopen = () => setConnected(true);
            ws.onmessage = e => { try { const m = JSON.parse(String(e.data)); if (m.type === 'history') setMessages(m.messages); if (m.type === 'message') { setMessages(prev => [...prev.filter(v => v.id !== m.message.id),m.message].slice(-100)); setError(''); } if (m.type === 'error') setError(m.error); } catch { /* ignore malformed frame */ } };
            ws.onclose = () => { setConnected(false); if (!stopped) retry = setTimeout(open, 2000); };
            ws.onerror = () => ws.close();
        };
        open(); return () => { stopped = true; clearTimeout(retry); socket.current?.close(); };
    }, []);
    useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
    const send = (e: FormEvent) => { e.preventDefault(); if (!connected || !text.trim()) return; socket.current?.send(JSON.stringify({ name, text })); setText(''); };
    return <section className="tv-chat tv-chat-dock" aria-label="Live viewer chat"><header className="tv-chat-heading"><strong>Live chat</strong><span className={connected ? "connected" : ""}>{connected ? "● Connected" : "Connecting…"}</span></header><label className="tv-chat-name">Your nickname<input aria-label="Chat nickname" maxLength={20} value={name} onChange={e => setName(e.target.value)}/></label><div className="tv-chat-messages" ref={list} role="log" aria-label="Live chat messages" aria-live="polite">{messages.length ? messages.map(m => <div className="tv-chat-message" key={m.id}><span><strong>{m.name}</strong><time>{new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></span><p>{m.text}</p></div>) : <p className="tv-muted">Say hello to everyone watching.</p>}</div>{error && <p role="status" className="tv-chat-error">{error}</p>}<form onSubmit={send}><input aria-label="Chat message" value={text} onChange={e => setText(e.target.value)} maxLength={400} placeholder="Say something…" autoComplete="off"/><button disabled={!connected || !text.trim() || !name.trim()} type="submit">Send</button></form></section>;
}
