import { 
    tagWhitelist, attributeWhitelist, eventWhitelist, styleSanitizer, 
    createSanitizedStyle
} from "./sanitize.js";

class BuilderError extends Error {
    constructor(name, message) {
        super(message);
        this.name = name;
    }
}

const InvalidTag = tag => new BuilderError("InvalidTag", `Blacklisted element type '${tag}' passed to build`);
const InvalidAttribute = explanation => new BuilderError("InvalidAttribute", explanation);
const InvalidHandle = handle => new BuilderError("InvalidHandle", `Element handle ${handle} is not recognized`);
const DuplicateHandle = handle => new BuilderError("DuplicateHandle", `Element handle ${handle} already exists`);
const InvalidUpdate = (type, explanation) => new BuilderError("InvalidUpdate", `Update type '${type}' ${explanation}`);

export function createRoot(any) {
    if (!any instanceof HTMLElement) any = getByHandle(any);
    const element = getByHandle(any);
    const handle = adopt(element);
    element.attachShadow({ mode: "open" });
    element.dataset.root = "true";
    return handle;
}

const handleMap = new Map();
const defaultHandles = {};

const nextHandle = tag => `${tag}-${++defaultHandles[tag] || (defaultHandles[tag] = 1)}`;

export const getByHandle = (handle, fatal=true) => {
    if (handle instanceof HTMLElement) return handle;
    if (handle instanceof Component) handle = handle.handle;
    const element = handleMap.get(handle);
    if (fatal && !element) throw InvalidHandle(handle);
    return element;
}

const getParent = handle => getByHandle(handle).parentElement;

const registrationWatchers = new Set();

const registerHandle = (handle, element) => {
    registrationWatchers.forEach(callback => callback(handle));
    handleMap.set(handle, element);
};

export const watchHandleCreation = () => {
    const cache = [];
    const handler = cache.push.bind(cache);
    registrationWatchers.add(handler);
    return {
        stop: () => {
            registrationWatchers.delete(handler);
            return cache;
        } 
    };
};

const normalize = handle => handle instanceof Component ? handle.handle : handle instanceof HTMLElement ? handle.dataset.handle : handle;
export const isComponent = handle => handleMap.has(normalize(handle));
export const isMounted = handle => !!getByHandle(handle).parentElement;

const callbackMap = new Map();
const globalCallbacks = new Map();

const registerCallback = (handle, type, callback) => {
    handle = normalize(handle);
    let callbacks = callbackMap.get(handle);
    if (!callbacks) {
        callbacks = new Map();
        callbackMap.set(handle, callbacks);
    }
    let eventCallbacks = callbacks.get(type);
    if (!eventCallbacks) {
        eventCallbacks = new Set();
        callbacks.set(type, eventCallbacks);
    }
    eventCallbacks.add(callback);
};

const unregisterCallback = (handle, type, callback) => callbackMap.get(normalize(handle))?.get(type)?.delete(callback);

export const registerGlobalCallback = (type, callback) => {
    let callbacks = globalCallbacks.get(type);
    if (!callbacks) {
        callbacks = new Set();
        globalCallbacks.set(type, callbacks);
    }
    callbacks.add(callback);
};

export const unregisterGlobalCallback = (type, callback) => globalCallbacks.get(type)?.delete(callback);

const sendEventCallbacks = (handle, type, data) => {
    return globalCallbacks.get(type)?.values().reduce((cancel, callback) => callback(data, handle) || cancel, false) || callbackMap.get(normalize(handle))?.get(type)?.values().reduce((cancel, callback) => callback(data) || cancel, false);
}

function handleAttributeSpecialCases(element, name, value) {
    if (name.startsWith("data-") || name.startsWith("aria")) {
        element.setAttribute(name, value);
    } else if (name.startsWith("on")) {
        const event = name.slice(2);
        if (eventWhitelist.has(event)) element[name] = () => value("this is where you would filter actual event info");
        else throw InvalidAttribute(`Event type '${name}' is blacklisted`);
    } else switch(name) {
        case "class":
            element.className = value;
            break;
        case "className":
        case "textContent":
            element[name] = value;
            break;
        case "dataset":
            Object.entries(value).forEach(([k, v]) => element.dataset[k] = v);
            break;
        case "style":
            if (typeof value === "string") element.setAttribute("style", value.split(";").map(s => s.split(":")).filter(([p, ...d]) => styleSanitizer(p.trim(), d.join(":"))).map(s => s.join(":")).join(";"));
            else if (typeof value === "object") Object.entries(value).filter(([p, d]) => styleSanitizer(p, d)).forEach(([p, d]) => element.style[p] = d);
            break;
        case "src":
        case "href":
            const url = new URL(value);
            if (url.origin !== location.origin) throw InvalidAttribute(`'${name}' attribute must be of origin ${location.origin}`);
            element.setAttribute(name, url.toString());
            break;
        default:
            throw InvalidAttribute(`Element attribute ${name} is blacklisted`);
    }
}

const specialCaseAttributes = new Set(["className", "classList", "dataset", "style", "src", "href", "textContent"]);

function setAttribute(handle, name, value) {
    const element = getByHandle(handle);
    if (attributeWhitelist.has(name)) element.setAttribute(name, value);
    else handleAttributeSpecialCases(element, name, value);
}

function getAttribute(handle, name) {
    const element = getByHandle(handle);
    switch (name) {
        case "class":
            return element.className;
        case "className":
        case "classList":
        case "src":
        case "href":
        case "textContent":
            return element[name];
        case "dataset":
            return element.dataset;
        case "style":
            const proxy = {};
            Object.keys(element.style).forEach(property => {
                Object.defineProperty(proxy, property, {
                    get() {
                        return element.style[property];
                    },
                    set(value) {
                        if (styleSanitizer(property, value)) element.style[property] = value;
                    }
                });
            });
            return proxy;
        default:
            if (!attributeWhitelist.has(name)) throw InvalidAttribute(`Element attribute ${name} is blacklisted`);
            return element.getAttribute(name);
    }
}

const ignoredProperties = new Set(["tag", "handle", "children"]);

export function build(schema) {
    if (typeof schema === "string") return build({ tag: "span", textContent: schema });
    if (schema.placeholder) return build({ tag: "span", ...schema }); 
    if (!tagWhitelist.has(schema.tag)) throw InvalidTag(schema.tag);
    let handle = schema.handle;
    if (handleMap.has(handle)) throw DuplicateHandle(handle);
    else if (!handle) handle = nextHandle(schema.tag);
    const element = document.createElement(schema.tag);
    registerHandle(handle, element);
    element.dataset.handle = handle;
    for (const [name, value] of Object.entries(schema)) {
        if (ignoredProperties.has(name)) continue;
        setAttribute(element, name, value);
    }
    if (Array.isArray(schema.children)) schema.children.forEach(schema => {
        if (!schema) return;
        const handle = isComponent(schema) ? schema : build(schema);
        //if (isMounted(handle)) unmount(handle); // would suppress remounting error
        mount(handle, element);
    });
    sendEventCallbacks(handle, "build", { handle, schema });
    return handle;
}

const eventReferrer = handle => (name, data={}) => sendEventCallbacks(handle, name, data);

function update(handle, update) {
    const element = getByHandle(handle, false);
    const type = update.type;
    const lifecycle = eventReferrer(handle);
    if (!element) return;
    switch (update.type) {
        case "mount":
            if (isMounted(element)) throw InvalidUpdate(type, `called while element '${handle}' is already mounted`);
            if (!update.target) throw InvalidUpdate(type, "must have a 'target'");
            let targetElement = getByHandle(update.target);
            if (targetElement.dataset.root === "true") targetElement = targetElement.shadowRoot;
            if (lifecycle("beforeMount")) break;
            if (update.insertPosition) {
                if (update.insertPosition === "prepend") targetElement.prepend(element);
                else targetElement.insertAdjacentElement(update.insertPosition, element);
            } else targetElement.append(element);
            lifecycle("mount");
            break;
        case "unmount":
            if (!isMounted(element)) throw InvalidUpdate(type, `called while element '${handle}' isn't mounted`);
            if (lifecycle("beforeUnmount")) break;
            element.remove();
            lifecycle("unmount");
            break;
        case "destroy":
            if (lifecycle("beforeDestroy")) break;
            if (isMounted(element)) unmount(element);
            lifecycle("destroy");
            const actualHandle = normalize(handle);
            handleMap.delete(actualHandle);
            callbackMap.delete(actualHandle);
            break;
        case "rebuild":
            if (!update.schema) throw InvalidUpdate(type, "requires property 'schema'");
            if (lifecycle("beforeRebuild")) break;
            const wasMounted = isMounted(element);
            let parentHandle;
            if (wasMounted) parentHandle = element.parentElement.dataset.handle;
            destroy(element);
            const updatedHandle = update.tag ? build({ ...update.schema, handle: normalize(handle) }) : normalize(update.schema);
            if (wasMounted) mount(updatedHandle, parentHandle);
            lifecycle("rebuild");
            break;
        case "append":
            if (!update.target) throw InvalidUpdate(type, "must have a 'target'");
            if (update.target.tag) update.target = build(update.target);
            if (isMounted(update.target, element)) throw InvalidUpdate(type, "called while 'target' is already mounted as a descendant");
            mount(update.target, element);
            break;
        case "updateAttribute":
            if (!update.name || !update.value) throw InvalidUpdate(type, "requires properties 'name' and 'value'");
            setAttribute(element, update.name, update.value);
            break;
        case "sendEvent":
            if (!update.event || !update.data) throw InvalidUpdate(type, "requires properties 'event' and 'data'");
            const stopPropagation = sendEventCallbacks(handle, update.event, update.data);
            if (stopPropagation) break;
            if (update.event === "click") {
                // propagation (just click for now)
                let parent = element;
                while (parent = getParent(parent)) {
                    if (!parent.dataset.handle) break;
                    if (sendEventCallbacks(parent, update.event, update.data)) break;
                }
            }
            break;
        case "addEventListener":
            if (!update.event || !update.callback) throw InvalidUpdate(type, "requires properties 'event' and 'callback'");
            registerCallback(handle, update.event, update.callback);
            break;
        case "removeEventListener":
            if (!update.event || !update.callback) throw InvalidUpdate(type, "requires properties 'event' and 'callback'");
            unregisterCallback(handle, update.event, update.callback);
            break;
    }
}

export const mount = (handle, target, insertPosition) => update(handle, { type: "mount", target, insertPosition });
export const unmount = handle => update(handle, { type: "unmount" });
export const destroy = handle => update(handle, { type: "destroy" });
export const rebuild = (handle, schema) => update(handle, { type: "rebuild", schema });
export const append = (handle, target, prepend=false) => update(handle, { type: "append", target, insertPosition: prepend ? "prepend" : undefined });
export const updateAttribute = (handle, name, value) => update(handle, { type: "updateAttribute", name, value });
export const sendEvent = (handle, event, data={}) => update(handle, { type: "sendEvent", event, data });
export const addEventListener = (handle, event, callback) => update(handle, { type: "addEventListener", event, callback });
export const removeEventListener = (handle, event, callback) => update(handle, { type: "removeEventListener", event, callback });

export const adopt = element => {
    if (element.dataset.handle) return element;
    const handle = nextHandle(element.tagName.toLowerCase());
    element.dataset.handle = handle;
    registerHandle(handle, element);
    return handle;
};

export const getChild = (handle, n=0) => {
    const element = getByHandle(handle);
    let index = 0;
    for (const c of element.children) {
        if (isComponent(c)) {
            if (index === n) return c.dataset.handle;
            else index++
        }
    }
};

export const query = (root, selector) => {
    const element = getByHandle(root, false).querySelector(selector);
    if (element) return element.dataset.handle;
};

export const queryBy = (root, attribute, value) => query(root, `[data-${attribute}="${value}"]`);

const snakeToCamel = string => string.split("-").reduce((str, seg) => {
    if (str) seg[0] = seg[0].toUpperCase();
    return str + seg;
}, "");

export class Component {
    constructor(any, enablePropertyGetters=false) {
        this.handle = any instanceof HTMLElement ? (any.dataset.handle ? any.dataset.handle : adopt(any)) : typeof any === "object" ? build(any) : any;
        if (!isComponent(this.handle)) throw InvalidHandle(this.handle);
        if (enablePropertyGetters) {
            const proxyAttribute = name => Object.defineProperty(this, snakeToCamel(name), {
                get: () => getAttribute(this.handle, name),
                set: value => updateAttribute(this.handle, name, value)
            });
            attributeWhitelist.forEach(proxyAttribute);
            specialCaseAttributes.forEach(proxyAttribute);
        }
    }
    mount(target, insertPosition=null) {
        mount(this.handle, target, insertPosition);
        return this;
    }
    unmount() {
        unmount(this.handle);
        return this;
    }
    destroy() {
        destroy(this.handle);
        return this;
    }
    rebuild(schema) {
        rebuild(this.handle, schema);
        return this;
    }
    append(target, prepend=false) {
        append(this.handle, target, prepend);
        return this;
    }
    set(name, value) {
        updateAttribute(this.handle, name, value);
        return this;
    }
    get(name) {
        return getAttribute(this.handle, name);
    }
    sendEvent(type, data) {
        sendEvent(this.handle, type, data);
        return this;
    }
    on(type, callback) {
        addEventListener(this.handle, type, callback);
        return this;
    }
    off(type, callback) {
        removeEventListener(this.handle, type, callback);
        return this;
    }
    getChild(n=0, enablePropertyGetters=true) {
        const handle = getChild(this.handle, n);
        if (!handle) return undefined;
        return asComponent(handle, enablePropertyGetters);
    }
    query(selector, enablePropertyGetters=true) {
        return asComponent(query(this, selector), enablePropertyGetters)
    }
    queryBy(attribute, value, enablePropertyGetters=true) {
        return asComponent(queryBy(this, attribute, value), enablePropertyGetters);
    }
}

const asComponent = (handle, ...x) => handle && new Component(handle, ...x);

eventWhitelist.forEach(type => {
    window.addEventListener(type, ev => {
        if (ev.target && isComponent(ev.target)) sendEvent(ev.target, type);
    });
});

export async function applyStyle(root, link) {
    try {
        const text = await (await fetch(link)).text();
        const element = getByHandle(root);
        if (!element || !element.dataset.root === "true") return;
        const style = createSanitizedStyle(text);
        element.shadowRoot?.adoptedStyleSheets.push(style);
    } catch (err){
        console.error("Error occured while applying style:", err);
    }    
}