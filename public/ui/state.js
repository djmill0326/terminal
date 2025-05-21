import { isNumericAscii } from "../helpers.js";
import { destroy, mount, registerGlobalCallback, unregisterGlobalCallback, watchHandleCreation } from "./builder.js";

export const shallow = o => (o._shallow = true) && o;

function determineRelevantIndices(array, operation, args) {
    switch (operation) {
        case "push":
            return { add: [array.length, array.length + args.length] };
        case "pop":
            return { remove: [array.length - 1, array.length] };
        case "shift":
            return { remove: [0, 1] };
        case "unshift":
            return { add: [0, args.length] };
        case "splice":
            const [start, count] = args;
            const end = typeof count === "number" ? start + count : array.length;
            const changes = {};
            if (end - start > 0) changes.remove = [start, end];
            if (args.length > 2) changes.add = [start, start + args.length - 2];
            return changes;
    }
}

function createKeyedArray(array, path, stateManager, stateProxy=null) {
    if (array.keyArray) return array;
    const wrappedArray = [...array];
    wrappedArray._shallow = array._shallow;
    const keyArray = array.map(() => Symbol("list-item"));
    let prop = stateProxy;
    ['push', 'pop', 'shift', 'unshift', 'splice'].forEach(method => {
        wrappedArray[method] = (...args) => {
            switch (method) {
                case "pop":
                case "shift":
                    keyArray[method]();
                    break;
                case "push":
                case "unshift":
                    keyArray[method](...args.map(() => Symbol("list-item")));
                    break;
                case "splice":
                    const [x, y, ...z] = args;
                    keyArray[method](x, y, ...z.map(() => Symbol("list-item")));
            }
            const indicesModified = determineRelevantIndices(wrappedArray, method, args);
            const result = Array.prototype[method].apply(wrappedArray, args);
            stateManager?.informUpdate(path, { indices: indicesModified, prop });
            return result;
        };
    });
    wrappedArray.keyArray = keyArray;
    wrappedArray.adoptState = stateProxy => prop = stateProxy;
    return wrappedArray;
}

const getPath = (path, prop) => `${path}${isNumericAscii(prop) ? `[${prop}]` : `${path ? "." : ""}${prop}`}`;

const Proxy = Object.create(null);
Proxy.valueOf = function() { return this.$; };

function defineStateWrapper(stateManager, object) {
    const proxy = Object.create(Proxy);

    // Instead of recursion, use a simple stack to iterate to depth.
    function recurseFlat(root, proxyRoot, path) {
        const stack = [{ root, proxyRoot, path }];
        while (stack.length > 0) {
            const { root, proxyRoot, path } = stack.pop();

            // Define special properties upon initial proxy creation.
            if (!proxyRoot.path) {
                Object.defineProperty(proxyRoot, "path", { value: path });
                Object.defineProperty(proxyRoot, "$", { get: new Function(`return this${path ? "." : ""}${path}`).bind(object) });
            }

            // Early return for primitive types, removing any orphaned properties
            // that were present if root used to be an object.
            if (typeof root !== "object" || root === null) {
                for (const key of Object.keys(proxyRoot)) delete proxyRoot[key];
                continue;
            };

            // Remove any props not present in the current root.
            for (const key of Object.keys(proxyRoot)) {
                if (!root.hasOwnProperty(key)) delete proxyRoot[key];
            }

            // Apply `adoptState` hook if present, for any special
            // state-aware object that requires a proxy reference.
            if (root.adoptState) root.adoptState(proxyRoot);

            // Closure for child properties. More memory efficient than copying
            // the whole function string for each individual custom setter.
            const setter = (v, { proxy }) => {
                const path = proxy.path;

                // Ensure state proxy remains valid for new prop's children
                recurseFlat(v, proxy, path);

                const prev = proxy.$; // May enable unwanted mutations. Could clone here.

                // Replace with better solution (microtask queue).
                // This is here to force updates to occur after the state has actually changed.
                // Since we're returning the new value and having the dynamically-generated setter
                // actually update the state, some form of delay is required.
                setTimeout(() => stateManager.informUpdate(path, { prop: proxy, prev }), 0);

                // All arrays are sneakily transformed into keyed variants to enable index-component tracking.
                return Array.isArray(v) ? createKeyedArray(v, path, stateManager, proxy) : v;
            };
            
            const isArray = Array.isArray(root);
            
            // Iterate through every child property
            for (const [key, value] of Object.entries(root)) {
                // Ignoring special cases
                if (key === "_shallow" || isArray && key === "keyArray") continue;

                // Functions are simply proxied to the underlying object,
                // where mutations are expected to be handled by the caller/callee.
                // This is to enable behaviors like the tracked mutations for array functions.
                if (typeof value === "function") {
                    if (!proxyRoot[key]) Object.defineProperty(proxyRoot, key, { get: new Function(`return this${path ? "." : ""}${path}.${key}`).bind(object) });
                    continue;
                }

                // Using the helper `shallow(...)` when creating a state object will cause any child properties to effectively
                // be ignored in the reactive system, allowing simple, targeted updates in very deep state trees.
                if (root._shallow) continue;

                // Shadow the existing proxy object, or create a new one.
                const proxy = proxyRoot[key] ?? Object.create(Proxy);

                // Apply same logic to all relevant descendants.
                const newPath = getPath(path, key);
                stack.push({ root: root[key], proxyRoot: proxy, path: newPath });

                // Define actual property on root proxy object.
                // The getter returns the child proxy, which allows one to pass "state references" around
                // almost arbitrarily to reactive listeners and still allows for near-native usage as the
                // underlying data. (When passed to a reactive callback, state is resolved to the underlying,
                // which means there's no need to treat them any differently. In other cases, it will act like
                // its primitive version (if a primitive type) in cases where `valueOf` conversion would naturally
                // happen. Otherwise, `prop.$` is available to access the *actual* underlying reference, which is
                // always fresh, regardless of when the proxy reference was captured.)
                if (!proxyRoot[key]) Object.defineProperty(proxyRoot, key, {
                    configurable: true,
                    enumerable: true,
                    get: () => proxy,
                    set: new Function("v", `this.object.${newPath}=this.setter(v,this)`).bind({ object, proxy, setter })
                });
            }
        }
    }
    
    // Fill out the reactive object tree.
    recurseFlat(object, proxy, "");
    return {
        state: proxy,
        invalidate: prop => recurseFlat(prop.$, prop, prop.path) /* the reason adoptState exists, required for reactive Arrays. */
    };
}

const objectMap = (source, target, replacer, objectTest=()=>true, path="") => Object.entries(source).forEach(([k, v]) => {
    const childPath = `${path ? `${path}.` : ""}${k}`;
    if (typeof v === "object" && !objectTest(v)) {
        target[k] = {};
        objectMap(v, target[k], replacer, objectTest, childPath);
    } else {
        target[k] = replacer(v, k, childPath);
    }
});

/* I doubt procedural JS beats a simple Regex
const propagateThroughPath = (path, f) => {
    const segments = [];
    let currentPath = "";
    let temp = "";
    for (const c of path) {
        if (c === "." || c === "[") {
            segments.push({ path: currentPath });
            temp = "";
        } else if (c === "]") {
            const pos = parseInt(temp);
            const prevSegment = segments[segments.length - 1];
            prevSegment.context = { indices: determineRelevantIndices(null, "splice", [pos, 1, null]) };
            segments.push({ path: currentPath });
        } else temp += c;
        currentPath += c;
    }
    if ((segments.length === 0 && path) || segments[segments.length - 1].path.length < path.length) segments.push({ path });
    segments.forEach(f);
}; */

const propagateThroughPath = (path, f) => {
    let segment;
    let currentPath = "";
    for (const [v, i] of path.matchAll(/^\w+|\.\w+|\[(\d+)\]/g)) {
        currentPath += v;
        if (i) segment.context = { indices: determineRelevantIndices(null, "splice", [parseInt(i), 1, null]) };
        if (segment) f(segment);
        segment = { path: currentPath };
    }
    f(segment);
};

export default function createState(initial={}) {
    const dependencies = new Map();
    const propertyMap = new Map();

    const updatePropDependencies = (path, renderFunc, affectedHandles) => {
        let propDeps = dependencies.get(path);
        if (!propDeps) {
            propDeps = new Map();
            dependencies.set(path, propDeps);
        }
        propDeps.set(renderFunc, { renderFunc, affectedHandles });
    };

    const manager = {
        informUpdate(path, context={}) {
            if (context.indices) invalidate(context.prop);
            propagateThroughPath(path, info => dependencies.get(info.path)?.forEach(d => {
                const ctx = info.context ? { ...context, ...info.context } : context;
                const props = propertyMap.get(d.renderFunc).map(p => p.$);
                if (d.affectedHandles) {
                    d.affectedHandles.forEach(destroy);
                    const watcher = watchHandleCreation();
                    d.renderFunc.apply(ctx, props);
                    d.affectedHandles = watcher.stop();
                } else d.renderFunc.apply(ctx, props);
            }));
        },
        reactive(renderFunc, ...props) {
            const watcher = watchHandleCreation();
            renderFunc.apply({}, props.map(p => p.$));
            const affectedHandles = watcher.stop();
            propertyMap.set(renderFunc, props);
            props.forEach(({ path }) => updatePropDependencies(path, renderFunc, affectedHandles));
            return renderFunc;
        },
        reactiveList(renderFunc, listProp, ...props) {
            const keyHandleMap = new Map();
            let tempHandleMap = new Map();
            let previousKeys = [];
            function renderList(...props) {
                const list = listProp.$;
                if (this.indices) {
                    const { add, remove } = this.indices;
                    if (add) {
                        const [begin, end] = add;
                        const endHandle = keyHandleMap.get(previousKeys[begin])?.at(0);
                        if (endHandle) {
                            for (let i = begin; i < end; i++) {
                                let previousMount;
                                const mountHandler = (_, handle) => {
                                    if (handle === previousMount) return;
                                    previousMount = handle;
                                    mount(handle, endHandle, "beforebegin");
                                    return true;
                                };
                                const watcher = watchHandleCreation();
                                registerGlobalCallback("beforeMount", mountHandler);
                                renderFunc(list[i], i, ...props);
                                unregisterGlobalCallback("beforeMount", mountHandler);
                                tempHandleMap.set(list.keyArray[i], watcher.stop());
                            }
                        } else {
                            for (let i = begin; i < end; i++) {
                                const watcher = watchHandleCreation();
                                renderFunc(list[i], i, ...props);
                                tempHandleMap.set(list.keyArray[i], watcher.stop());
                            }
                        }
                    }
                    if (remove) {
                        for (let i = remove[0]; i < remove[1]; i++) {
                            const key = previousKeys[i];
                            keyHandleMap.get(key).forEach(destroy);
                            keyHandleMap.delete(key);
                        }
                    }
                } else for (let i = 0; i < Math.max(list.length, previousKeys.length); i++) {
                    const oldKey = previousKeys[i];
                    keyHandleMap.get(oldKey)?.forEach(destroy);
                    keyHandleMap.delete(oldKey);
                    const item = list[i];
                    if (item !== undefined) {
                        const watcher = watchHandleCreation();
                        renderFunc(item, i, ...props);
                        tempHandleMap.set(list.keyArray[i], watcher.stop());
                    }
                }
                tempHandleMap.forEach((v, k) => keyHandleMap.set(k, v));
                tempHandleMap.clear();
                previousKeys = [...list.keyArray];
            }
            renderList.apply({}, ...props.map(p => p.$));
            propertyMap.set(renderList, props);
            [listProp, ...props].forEach(({ path }) => updatePropDependencies(path, renderList));
            return renderList;
        },
        forget(renderFunc, ...props) {
            propertyMap.delete(renderFunc);
            props.forEach(({ path }) => dependencies.get(path)?.delete(renderFunc));
        },
        scopeTo(handle) {
            const scopedPropertyMap = new Map();
            handle.on("destroy", () => {
                scopedPropertyMap.forEach((props, renderFunc) => this.forget(renderFunc, ...props));
                scopedPropertyMap.clear();
            });
            const scopedManager = {
                reactive: (renderFunc, ...props) => {
                    this.reactive(renderFunc, ...props);
                    scopedPropertyMap.set(renderFunc, props);
                },
                reactiveList: (renderFunc, listProp, ...props) => {
                    const renderList = this.reactiveList(renderFunc, listProp, ...props);
                    scopedPropertyMap.set(renderList, [listProp, ...props]);
                },
                forget: (renderFunc, ...props) => {
                    this.forget(renderFunc, ...props);
                    scopedPropertyMap.delete(renderFunc);
                }
            };
            Object.defineProperty(scopedManager, "state", { value: state });
            return scopedManager;
        }
    };

    const backingStore = {};
    objectMap(initial, backingStore, (v, _, path) => {
        if (Array.isArray(v)) return createKeyedArray(v, path, manager);
        if (v instanceof HTMLElement) return `${v.tagName}${v.id ? `#${v.id}` : ""}${v.className ? `.${v.className.replaceAll(" ", ".")}` : ""}`;
        return structuredClone(v);
    }, v => Array.isArray(v) || v instanceof HTMLElement);
    
    const { state, invalidate } = defineStateWrapper(manager, backingStore);
    Object.defineProperty(manager, "state", { value: state });
    return manager;
};