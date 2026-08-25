const { readFileSync } = require('fs');
const addon = require('./libstm32_napi.node');
// (set_trace removed: CODE hooks don't fire in this JIT unicorn build)

// ── firmware globals (from eth_http.ino / nm) ──
const TX_DESC   = 0x20000610;
const TX_PKT    = 0x20000008;
const RX_DESC   = 0x20000630;
const RX_BUF    = 0x20000660;
const RX_FRAME_IDX = 0x20000628;
const RX_FRAME_LEN = 0x2000062c;
const ETH_IRQ_FLAG = 0x20000620;
const ETH_MAX_PKT  = 1536;
const RX_DESC_CNT  = 4;

const FW = '/home/danish1075/Documents/stm32 F4/eth_http/eth_http.bin';
const buf = readFileSync(FW);

// ── helpers ──
function u32(n) { return Buffer.from([n & 0xff, (n>>8)&0xff, (n>>16)&0xff, (n>>24)&0xff]); }
function r32(off) { return addon.memRead(off, 4).readUInt32LE(0); }
function w32(off, v) { addon.memWrite(off, u32(v >>> 0)); }

// ── netsim (ported from site/netsim.js) ──
function makeNetSim() {
  const SERVER_MAC = [0x5a,0x94,0xef,0xe4,0x0c,0xdd];
  const CLIENT_MAC = [0x02,0x00,0x00,0x00,0x00,0x01];
  const SERVER_IP = [10,150,211,85];
  const CLIENT_IP = [192,168,4,2];
  const MASK = [255,255,255,0];
  const HTTP_PORT = 8092;
  const HTTP_BODY = 'HTTP/1.1 200 OK\r\nContent-Length: 29\r\nConnection: close\r\n\r\nHello from openhw HTTP server';
  let srvSeq = 0x10000000, clientSeq = 0, tcpSrcPort = 0, lastMsgType = 0;
  const stats = { tx:0, rx:0, dhcpOffers:0, dhcpAcks:0, synAcks:0, httpResponses:0 };
  const cksum = (b) => { let s=0; for(let i=0;i<b.length;i+=2){const w=(b[i]<<8)|(i+1<b.length?b[i+1]:0); s+=w;} while(s>>16) s=(s&0xffff)+(s>>16); return (~s)&0xffff; };
  const buildFrame = (dstIp, proto, payload) => {
    const ipLen = 20 + payload.length;
    const f = new Uint8Array(14 + ipLen);
    f.set(dstIp === 255 ? [255,255,255,255,255,255] : CLIENT_MAC, 0);
    f.set(SERVER_MAC, 6); f[12]=0x08; f[13]=0x00;
    const ip = 14;
    f[ip]=0x45; f[ip+1]=0; f[ip+2]=ipLen>>8; f[ip+3]=ipLen&0xff; f[ip+8]=128; f[ip+9]=proto;
    f.set(SERVER_IP, ip+12); f.set(dstIp, ip+16);
    const ck = cksum(f.subarray(ip, ip+20)); f[ip+10]=ck>>8; f[ip+11]=ck&0xff;
    f.set(payload, ip+20);
    return f;
  };
  const dhcpReply = (req, msgType) => {
    const bootp = new Uint8Array(300);
    const xid = (req[4]<<24)|(req[5]<<16)|(req[6]<<8)|req[7];
    bootp[0]=2; bootp[1]=1; bootp[2]=6;
    bootp[4]=xid>>24; bootp[5]=xid>>16; bootp[6]=xid>>8; bootp[7]=xid;
    bootp[8]=0x80; bootp[9]=0x00; bootp.set(CLIENT_IP,16); bootp.set(SERVER_IP,20);
    bootp.set(req.subarray(28,40),28); bootp.set([0x63,0x82,0x53,0x63],236);
    const opts = [53,1,msgType, 1,4,...MASK, 3,4,...SERVER_IP, 6,4,...SERVER_IP, 54,4,...SERVER_IP, 51,4,0,0,1,0x80, 255];
    bootp.set(opts,240);
    const udp = new Uint8Array(8+bootp.length);
    udp[0]=0;udp[1]=67;udp[2]=0;udp[3]=68; const ulen=8+bootp.length; udp[4]=ulen>>8;udp[5]=ulen&0xff; udp.set(bootp,8);
    return buildFrame(255,17,udp);
  };
  const tcpFrame = (flags, seq, ack, payload) => {
    const data = payload || new Uint8Array(0);
    const tcp = new Uint8Array(20+data.length);
    tcp[0]=HTTP_PORT>>8; tcp[1]=HTTP_PORT&0xff; tcp[2]=tcpSrcPort>>8; tcp[3]=tcpSrcPort&0xff;
    tcp[4]=seq>>24;tcp[5]=seq>>16;tcp[6]=seq>>8;tcp[7]=seq;
    tcp[8]=ack>>24;tcp[9]=ack>>16;tcp[10]=ack>>8;tcp[11]=ack;
    tcp[12]=0x50; tcp[13]=flags; tcp[14]=0xff; tcp[15]=0xff; tcp.set(data,20);
    return buildFrame(CLIENT_IP,6,tcp);
  };
  function onTx(frame) {
    stats.tx++;
    const replies = [];
    if (frame.length < 14) return replies;
    const et = (frame[12]<<8)|frame[13];
    if (et === 0x0806) {
      const a=14;
      if (frame[a]===0&&frame[a+1]===1&&frame[a+6]===0&&frame[a+7]===1) {
        const tip=[frame[a+24],frame[a+25],frame[a+26],frame[a+27]];
        if (tip.join('.')===SERVER_IP.join('.')) {
          const r=new Uint8Array(42);
          r.set(frame.subarray(6,12),0); r.set(SERVER_MAC,6); r[12]=0x08;r[13]=0x06;
          const p=14; r[p]=0;r[p+1]=1;r[p+2]=0x08;r[p+3]=0; r[p+4]=6;r[p+5]=4; r[p+6]=0;r[p+7]=2;
          r.set(SERVER_MAC,p+8); r.set(SERVER_IP,p+14); r.set(frame.subarray(p+8,p+14),p+18); r.set(frame.subarray(p+14,p+18),p+24);
          replies.push(r);
        }
      }
      return replies;
    }
    if (et !== 0x0800) return replies;
    const proto = frame[23]; const ihl=(frame[14]&0x0f)*4; const ipStart=14+ihl;
    if (proto===17) {
      const sport=(frame[ipStart]<<8)|frame[ipStart+1]; const dport=(frame[ipStart+2]<<8)|frame[ipStart+3];
      if (sport===68&&dport===67) {
        const dhcp=frame.subarray(ipStart+8); let mt=0;
        const opt=dhcp.subarray(240);
        for(let o=0;o<opt.length;){ if(opt[o]===0xff)break; if(opt[o]===0){o++;continue;} if(opt[o]===53){mt=opt[o+2];break;} o+=opt[o+1]+2; }
        lastMsgType=mt;
        if(mt===1){ stats.dhcpOffers++; replies.push(dhcpReply(dhcp,2)); }
        else if(mt===3){ stats.dhcpAcks++; replies.push(dhcpReply(dhcp,5)); }
      }
      return replies;
    }
    if (proto===6) {
      const sport=(frame[ipStart]<<8)|frame[ipStart+1]; const dport=(frame[ipStart+2]<<8)|frame[ipStart+3];
      if (dport===HTTP_PORT) tcpSrcPort=sport;
      if (tcpSrcPort===0) return replies;
      const seq=(frame[ipStart+4]<<24)|(frame[ipStart+5]<<16)|(frame[ipStart+6]<<8)|frame[ipStart+7];
      const fl=frame[ipStart+13]; const th=((frame[ipStart+12]>>4)&0x0f)*4; const dlen=frame.length-ipStart-th;
      if (fl===0x02){ stats.synAcks++; replies.push(tcpFrame(0x12,srvSeq,seq+1,null)); }
      else if((fl&0x18)===0x18&&dlen>0){ const ack=seq+dlen; stats.httpResponses++; replies.push(tcpFrame(0x10,srvSeq,ack,null)); replies.push(tcpFrame(0x19,srvSeq,ack,new TextEncoder().encode(HTTP_BODY))); }
      return replies;
    }
    return replies;
  }
  return { onTx, stats };
}
const net = makeNetSim();

// ── emulator setup ──
addon.createArmEngine();
addon.initModel();
addon.memMap(0x08000000, 0x00100000, 7);
addon.memMap(0x20000000, 0x00020000, 7);
addon.memMap(0x40000000, 0x70000000, 7);
addon.memMap(0xE0000000, 0x00100000, 7);

const sp = buf.readUInt32LE(0);
const pc = buf.readUInt32LE(4);
console.error('SP=0x'+sp.toString(16)+' PC=0x'+pc.toString(16));
addon.setSp(sp);
addon.setPc(pc);
addon.memWrite(0x08000000, buf);

addon.hookMemRead(0x40000000, 0x70000000);
addon.hookMemWrite(0x40000000, 0x70000000);

// ── RX injection ──
let rxSlot = 0;
let injectCount = 0;
function injectRx(frame) {
  const slot = rxSlot;
  rxSlot = (rxSlot + 1) % RX_DESC_CNT;
  addon.memWrite(RX_BUF + slot*ETH_MAX_PKT, Buffer.from(frame));
  w32(RX_DESC + slot*8, ((frame.length & 0x3FFF) << 16)); // OWN=0, len in [28:16]
  w32(RX_FRAME_IDX, slot);
  w32(RX_FRAME_LEN, frame.length);
  const flag = r32(ETH_IRQ_FLAG);
  w32(ETH_IRQ_FLAG, flag | 2);
  addon.ethRxDone();
  addon.ethClearRxPoll();
  injectCount++;
  if (frame[23] === 6) {
    const hex = Array.from(frame.slice(0,54)).map(b=>b.toString(16).padStart(2,'0')).join(' ');
    const f2 = r32(ETH_IRQ_FLAG), idx = r32(RX_FRAME_IDX), ln = r32(RX_FRAME_LEN);
    process.stderr.write(`INJECT#${injectCount} TCP slot=${slot} len=${frame.length} flagPre=${flag.toString(16)} flagPost=${f2.toString(16)} idx=${idx} len=${ln} pc=0x${(addon.getPc()>>>0).toString(16)}\n`);
  }
}

// ── run loop ──
const TOTAL = 100_000_000;
const STEP = 1_000_000;
let totalInst = 0;
let rounds = 0;
let lastUart = '';
let probeAfter = -1;
let probeCount = 0;
let synTrace = 0;
let cur = (pc | 1) >>> 0;
let tEmu = 0;
const t0 = Date.now();
while (totalInst < TOTAL) {
  const stp = synTrace > 0 ? 500 : STEP;
  const te = process.hrtime.bigint();
  addon.emuStart(cur, 0, 0, stp);
  tEmu += Number(process.hrtime.bigint() - te);
  cur = (addon.getPc() | 1) >>> 0;
  totalInst += stp;
  if (synTrace > 0) {
    synTrace--;
    const f = r32(ETH_IRQ_FLAG);
    process.stderr.write(`SYNTRACE pc=0x${(addon.getPc()>>>0).toString(16)} flag=${f.toString(16)}\n`);
  }
  const u = addon.getUartOutput();
  if (u) require('fs').writeSync(1, u);
  if (probeAfter >= 0 && probeCount < 20) {
    const f = r32(ETH_IRQ_FLAG), idx = r32(RX_FRAME_IDX), ln = r32(RX_FRAME_LEN);
    const conn = r32(0x20000658), ttgt = r32(0x20000650), tsrc = r32(0x20000000);
    const b = [...addon.memRead(RX_BUF + idx*1536, 54)].map(x=>('0'+x.toString(16)).slice(-2)).join(' ');
    process.stderr.write(`PROBE#${probeCount} pc=0x${(addon.getPc()>>>0).toString(16)} flag=${f.toString(16)} idx=${idx} len=${ln} conn=${conn} tgt=${ttgt.toString(16)} src=${tsrc.toString(16)}\n   f54=${b}\n`);
    probeCount++;
  }
  // TX poll -> capture frame, compute replies
  if (addon.ethIsTxPoll()) {
    const desc = addon.ethGetTxDescAddr();
    const d0 = r32(desc);
    const len = d0 & 0x3FFF;
    const dptr = r32(desc + 4);
    const frame = new Uint8Array(addon.memRead(dptr, len));
    addon.ethClearTxPoll();
    addon.ethTxDone();
    const flag = r32(ETH_IRQ_FLAG);
    w32(ETH_IRQ_FLAG, flag | 1);
    const replies = net.onTx(frame);
    if (frame[23] === 6) {
      const fl = frame[47] & 0x3f;
      if (fl === 0x02) { const sport=(frame[34]<<8)|frame[35]; const tsp = r32(0x20000000); process.stderr.write(`SYN TX sport=0x${sport.toString(16)} tcp_src_port=0x${tsp.toString(16)}\n`);       synTrace = 4000; }
      if (fl === 0x18) { const sport=(frame[34]<<8)|frame[35]; process.stderr.write(`GET/PSH TX sport=0x${sport.toString(16)}\n`); }
    }
    for (const r of replies) {
      if (r[23] === 6 && (r[47] & 0x12) === 0x12) { probeAfter = totalInst; probeCount = 0; process.stderr.write(`  -> inject SYN-ACK\n`); }
      if (r[23] === 6 && (r[47] & 0x18) === 0x18) process.stderr.write(`  -> inject HTTP resp (len=${r.length})\n`);
      injectRx(r);
    }
  }
  // also drain any pending RX when poll armed
  // (injected above; nothing queued separately)
}
const ms = Date.now() - t0;
console.error('\n--- stats ---');
console.error('instructions:', totalInst);
console.error('wall ms:', ms);
console.error('MIPS:', (totalInst/(ms/1000)/1e6).toFixed(2));
console.error('emu-time ms:', (tEmu/1e6).toFixed(0), ' wall ms:', ms, ' emu-only MIPS:', (totalInst/(tEmu/1e9)).toFixed(2));
try { const c = addon.get_counts(); console.error('MMIO reads:', c[0], ' writes:', c[1]); } catch(e){}
console.error('netsim stats:', JSON.stringify(net.stats));
