// Checks free public TURN servers from a real browser (run in CI).
// For each candidate: two peers in one page, relay-only ICE, and a data
// channel must open. Prints one line per server; never fails the job.
import { chromium } from 'playwright';

const CANDIDATES = [
  { name: 'openrelay udp 80', urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { name: 'openrelay tcp 443', urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { name: 'openrelay turns 443', urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { name: 'freestun udp 3478', urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
  { name: 'freestun turns 5350', urls: 'turns:freestun.net:5350', username: 'free', credential: 'free' },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
for (const c of CANDIDATES) {
  const result = await page.evaluate(async (server) => {
    const cfg = { iceServers: [{ urls: server.urls, username: server.username, credential: server.credential }], iceTransportPolicy: 'relay' };
    const a = new RTCPeerConnection(cfg);
    const b = new RTCPeerConnection(cfg);
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    let relayCandidates = 0;
    const count = (e) => e.candidate && e.candidate.type === 'relay' && relayCandidates++;
    a.addEventListener('icecandidate', count);
    const ch = a.createDataChannel('t');
    const opened = new Promise((res) => (ch.onopen = () => res('open')));
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const t0 = performance.now();
    const outcome = await Promise.race([opened, new Promise((res) => setTimeout(() => res('timeout'), 12000))]);
    const ms = Math.round(performance.now() - t0);
    a.close();
    b.close();
    return { outcome, ms, relayCandidates };
  }, c);
  console.log(`TURN ${result.outcome === 'open' ? 'OK  ' : 'FAIL'} ${c.name.padEnd(22)} ${result.outcome} in ${result.ms} ms, relay candidates: ${result.relayCandidates}`);
}
await browser.close();
