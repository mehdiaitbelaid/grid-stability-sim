'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function classList() {
    const names = new Set();
    return {
        add(...items) { items.forEach(item => names.add(item)); },
        remove(...items) { items.forEach(item => names.delete(item)); },
        contains(item) { return names.has(item); },
        toggle(item, force) {
            const enabled = force === undefined ? !names.has(item) : Boolean(force);
            if (enabled) names.add(item);
            else names.delete(item);
            return enabled;
        }
    };
}

function makeElement(id = '') {
    const element = {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        className: '',
        classList: classList(),
        style: {},
        dataset: {},
        children: [],
        parentElement: { clientWidth: 1200, clientHeight: 800, offsetWidth: 224 },
        addEventListener() {},
        setAttribute() {},
        getAttribute() { return null; },
        prepend(child) { this.children.unshift(child); },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
        },
        querySelector() { return makeElement(); },
        getContext() { return {}; }
    };
    Object.defineProperty(element, 'lastChild', {
        get() { return this.children[this.children.length - 1]; }
    });
    return element;
}

function inlineApplicationScript(html) {
    const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
    const match = scripts.find(script => script[1].includes('function physicsStep'));
    if (!match) throw new Error('Could not find the simulator inline script');
    return match[1];
}

function createHarness() {
    const elements = new Map();
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    };
    const documentElement = makeElement('documentElement');
    const document = {
        documentElement,
        getElementById: getElement,
        createElement: tag => makeElement(tag),
        addEventListener() {},
        querySelector() { return makeElement(); },
        querySelectorAll() { return []; }
    };

    let randomState = 123456789;
    const deterministicMath = Object.create(Math);
    deterministicMath.random = () => {
        randomState = (1664525 * randomState + 1013904223) >>> 0;
        return randomState / 2 ** 32;
    };

    let nextFrameId = 1;
    const queuedFrames = new Map();
    const window = {
        addEventListener() {},
        devicePixelRatio: 1,
        matchMedia() { return { matches: true, addEventListener() {}, removeEventListener() {} }; }
    };
    const context = {
        console,
        Date,
        Math: deterministicMath,
        GridPhysics: require(path.join(repoRoot, 'physics-core.js')),
        document,
        window,
        performance: { now: () => 0 },
        isFinite,
        setTimeout,
        clearTimeout,
        requestAnimationFrame(callback) {
            const id = nextFrameId++;
            queuedFrames.set(id, callback);
            return id;
        },
        cancelAnimationFrame(id) { queuedFrames.delete(id); }
    };
    context.globalThis = context;

    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const source = inlineApplicationScript(html);
    const boot = source.lastIndexOf('\ncacheEls();');
    if (boot < 0) throw new Error('Could not isolate simulator boot code');

    vm.createContext(context);
    vm.runInContext(source.slice(0, boot), context, { filename: 'index.html' });
    vm.runInContext(`
        updateBenchmarkDisplay = () => {};
        resize = () => {};
        buildAssets = () => {};
        renderAssets = () => {};
        draw = () => {};
        seedReadouts = () => {};
        updateDisplays = () => {};
        log = () => {};
        setRunUI = () => {};
        playEntrance = () => {};
        stageFlash = () => {};
    `, context);

    return {
        element: getElement,
        run(code) { return vm.runInContext(code, context); }
    };
}

module.exports = { createHarness };
