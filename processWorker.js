import { parentPort, workerData } from "worker_threads";

const callbacks = new Map();
let callbackId = 0;

const call = (name, args, options={}) => parentPort.postMessage({ type: "call", name, args, ...options });

const callAsync = (name, args, options={}) => new Promise(resolve => {
    const id = ++callbackId;
    call(name, args, { id, ...options });
    callbacks.set(id, resolve);
    setTimeout(() => callbacks.delete(id), 10000);
});

const thisProxy = { ...workerData, state: {} };
for (const [name, usesCallback] of workerData.callables) thisProxy[name] = usesCallback ?
    (...args) => callAsync(name, args) :
    (...args) => call(name, args);

const handlers = {};

for (let [name, text] of Object.entries(workerData.handlers)) {
    // transform function text to support object method syntax (eg. name() {}, as opposed to function name() {})
    // if it's not an arrow function, and 'function' is either not found, or found after the function's name, it is inserted appropriately
    const nameIndex = text.indexOf(name);
    const functionIndex = text.indexOf("function");
    if (nameIndex !== -1 && (functionIndex === -1 || functionIndex > nameIndex)) text = text.slice(0, nameIndex).concat("function ", text.slice(nameIndex));
    handlers[name] = new Function(`return (${text})`)().bind(thisProxy);
}

parentPort.on("message", async data => {
    switch (data.type) {
        case "call":
            const handler = handlers[data.name];
            if (!handler) return;
            if (!Array.isArray(data.payload)) data.payload = [data.payload];
            await handler(...data.payload);
            if (data.name === "destroy") parentPort.postMessage({ type: "exit" });
            break;
        case "callback":
            const callback = callbacks.get(data.id);
            await callback(data.result);
            callbacks.delete(data.id);
            break;
        case "update":
            handlers.update(data.payload);
            break;
        case "share":
            handlers.update(null, data.payload);
            break;
    }
});