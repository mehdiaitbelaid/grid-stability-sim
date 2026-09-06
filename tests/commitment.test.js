'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../physics-core.js');
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);

test('inertia reports the physical sum even below the requested target', () => {
    const result=p.computeSyncInertia([{type:'conv',fuel:'gas',cap:10000,onlineCap:5000}],45000,0,4,140);
    close(result.gvaSeconds,20);
    close(result.shortfallGvaSeconds,120);
});

test('commitment funds the inertia target with real capacity and minimum output', () => {
    const nodes=[{id:'gas',type:'conv',fuel:'gas',cap:10000,onlineCap:0,val:0}];
    p.commitConventional(nodes,1000,20);
    close(nodes[0].onlineCap,5000);
    const schedule=p.dispatchConventional(nodes,1000,false);
    close(schedule.gas,1500);
});

test('an impossible inertia target never exceeds nameplate capacity', () => {
    const nodes=[{id:'gas',type:'conv',fuel:'gas',cap:1000,val:0}];
    p.commitConventional(nodes,500,20);
    close(nodes[0].onlineCap,1000);
    close(p.computeSyncInertia(nodes,1000,0,4,20).shortfallGvaSeconds,16);
});

test('equivalent contingency removes the requested output and its online capacity once', () => {
    const nodes=[{id:'gas',type:'conv',fuel:'gas',cap:2000,onlineCap:1600,val:1200,p:1200},
        {id:'coal',type:'conv',fuel:'coal',cap:1000,onlineCap:800,val:600,p:600}];
    const loss=p.tripConventional(nodes,900);
    close(loss.powerMW,900);
    close(nodes.reduce((s,n)=>s+n.val,0),900);
    close(nodes.reduce((s,n)=>s+n.onlineCap,0),1200);
    close(p.computeSyncInertia(nodes,1000,0,4).gvaSeconds,4.8);
    close(nodes.reduce((s,n)=>s+n.lostCap,0),1200);
});

test('unavailable capacity cannot be recommitted or dispatched', () => {
    const nodes=[{id:'gas',type:'conv',fuel:'gas',cap:2000,onlineCap:1000,val:750,p:750,lostCap:1000}];
    p.commitConventional(nodes,5000,20);
    close(nodes[0].onlineCap,1000);
    close(p.dispatchConventional(nodes,5000,false).gas,950);
});

test('zero commitment produces a zero schedule', () => {
    close(p.dispatchConventional([{id:'gas',type:'conv',fuel:'gas',cap:1000,onlineCap:0}],1000,false).gas,0);
});
