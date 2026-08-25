const { readFileSync } = require('fs');
const addon = require('./libstm32_napi.node');

const FW = '/home/danish1075/Documents/stm32 F4/blinky/blinky_working.bin';
const buf = readFileSync(FW);

addon.createArmEngine();
addon.initModel();

// memory map: flash, sram, peripherals, system
addon.memMap(0x08000000, 0x00100000, 7);
addon.memMap(0x20000000, 0x00020000, 7);
addon.memMap(0x40000000, 0x70000000, 7);
addon.memMap(0xE0000000, 0x00100000, 7);

// vector table
const sp = buf.readUInt32LE(0);
const pc = buf.readUInt32LE(4);
console.log('SP=0x' + sp.toString(16), 'PC=0x' + pc.toString(16));
addon.setSp(sp);
addon.setPc(pc);
addon.memWrite(0x08000000, buf);

// hook whole peripheral space (no JS callbacks; model called directly)
addon.hookMemRead(0x40000000, 0xAFFFFFFF);
addon.hookMemWrite(0x40000000, 0xAFFFFFFF);

const TARGET = 50_000_000; // instructions
const t0 = Date.now();
addon.emuStart((pc | 1) >>> 0, 0, 0, TARGET);
const t1 = Date.now();
const ms = t1 - t0;

const uart = addon.getUartOutput();
const counts = addon.getCounts();

console.log('--- UART ---');
console.log(JSON.stringify(uart.slice(0, 400)));
console.log('--- stats ---');
console.log('instructions:', TARGET);
console.log('wall ms:', ms);
console.log('MIPS:', (TARGET / (ms / 1000) / 1e6).toFixed(2));
console.log('read hooks:', counts[0], 'write hooks:', counts[1]);
