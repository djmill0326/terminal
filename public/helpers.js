export const BASE_ANIMATION_TIME = 200;

const colorSet = [
    "lightcoral",
    "lightsalmon",
    "khaki",
    "springgreen",
    "lightseagreen",
    "cadetblue",
    "orchid",
    "palevioletred"
].reverse();

let paletteIndex = -1;
export function color() {
    if (++paletteIndex === colorSet.length) paletteIndex = 0;
    return colorSet[paletteIndex];
}

export function simulateDimensions(tag="span", className="", text="—") {
    return new Promise(resolve => { 
        const element = document.createElement(tag);
        element.textContent = text;
        element.className = className;
        element.style = "position: absolute; opacity: 0";
        document.body.append(element);
        setTimeout(() => {
            resolve([element.offsetWidth, element.offsetHeight]);
            element.remove();
        }, 0);
    });
}

export function isNumericAscii(c) {
    if (!c) return false;
    const cc = c.charCodeAt(0);
    return 47 < cc && cc < 58;
}

export function parseCommand(text, validator) {
    let argBuffer = [];
    let tempBuffer = "";
    let quoting = false;
    let previousWasSpace = false;
    for (const c of text) {
        if (c === ' ' && !(previousWasSpace || quoting)) {
            previousWasSpace = true;
            argBuffer.push(tempBuffer);
            tempBuffer = "";
        } else {
            previousWasSpace = false;
            if (c === '"') quoting = !quoting;
            else tempBuffer += c;
        }
    }
    if (tempBuffer.length) argBuffer.push(tempBuffer);
    const [type, ...args] = argBuffer;
    if (!validator || validator(type, args)) return { type, args };
}

export function createTerminalOutput(data) {
    const output = document.createElement("div");
    const text = document.createElement("div");
    const lines = data.text.split("\n").map(line => {
        const el = document.createElement("div");
        el.textContent = line;
        el.className = "term-line";
        return el;
    });
    text.className = `term-text${data.style ? ` ${data.style}` : ""}`;
    text.append(...lines);
    if (data.style) text.classList.add(data.style.split(" "));
    const timestamp = document.createElement("span");
    timestamp.textContent = new Date(data.timestamp ?? Date.now()).toLocaleTimeString();
    timestamp.className = "term-time";
    output.append(text, timestamp);
    output.className = "term-command";
    return output;
}

export async function createTab(name, mode, input, db) {
    const element = document.createElement("div");
    element.className = "term-output";
    const tab = {
        name, mode, element, color: color(),
        previousScroll: 0, 
        previousHeight: element.scrollHeight,
        history: await useHistory(input, db, mode),
    };
    tab.scrollback = useVirtualScrolling(tab);
    return tab;
};

export function buildPanelLayout(panel, tabs, selected) {
    let activePane;
    const n = Math.ceil(Math.sqrt(tabs.length));
    let emptyCount = n * n - tabs.length;
    let i = 0;
    for (let y = 0; y < n; y++) {
        const row = document.createElement("div");
        row.className = "term-grid";
        const skipCount = Math.ceil(emptyCount / n);
        emptyCount -= skipCount;
        for (let x = 0; x < n - skipCount; x++) {
            const el = document.createElement("div");
            el.className = "term-pane";
            el.dataset.tabindex = i;
            const tab = tabs[i++];
            el.append(tab.element);
            row.append(el);
            if (selected === tab) {
                el.classList.add("active");
                activePane = el;
            }
        }
        panel.append(row);
    }
    return activePane;
}

const pendingCallbacks = new Map();
export function collapseCallback(callback, metric=()=>true) {
    const resolve = () => {
        callback(...pendingCallbacks.get(callback).args);
        pendingCallbacks.delete(callback);
    }
    return (...x) => {
        let pending = pendingCallbacks.get(callback);
        if (!pending) {
            pending = {
                timeout: setTimeout(resolve, 0),
                args: []
            };
            pendingCallbacks.set(callback, pending);
        }
        if (metric(x, pending.args)) pending.args = x;
    }
}

export function createGroup(name, tabs=[], selected=null, onSelect=()=>{}) {
    const element = document.createElement("div");
    element.className = "term-output panel";
    let activePane = buildPanelLayout(element, tabs, selected);

    const callback = collapseCallback(onSelect, ([v], [p]) => p ? p.element.contains(v.element) : true);
    element.querySelectorAll(".term-pane").forEach(pane => {
        if (pane.dataset.attached) return;
        pane.dataset.attached = true;
        pane.addEventListener("click", () => {
            group.activeTab = tabs[pane.dataset.tabindex];
            if (activePane) activePane.classList.remove("active");
            activePane = pane;
            pane.classList.add("active");
            callback(group.activeTab, pane, group);
        })}
    );

    const group = {
        name: name || "Untitled Group",
        mode: tabs.map(t => t.mode).join("_"),
        tabs,
        element,
        initiator: selected,
        activeTab: selected ?? tabs[0],
        scrollback: new Proxy({}, { get: (_, k) => group.activeTab.scrollback[k] }),
        history: new Proxy({}, { get: (_, k) => group.activeTab.history[k] })
    };
    return group;
}

export function createScrollButton(tab) {
    const button = document.createElement("button");
    button.textContent = "Return to bottom ▼";
    button.className = "term-scroll-button";
    button.addEventListener("click", tab.scrollback.scrollToBottom);
    return button;
}

const animationIds = new Map();
export function animateScroll(element, x, y, duration=100) {
    const scrollLeft = element.scrollLeft;
    const scrollTop = element.scrollTop;
    const offsetLeft = x - element.scrollLeft;
    const offsetTop = y - element.scrollTop;
    const start = performance.now();
    const index = (animationIds.get(element) ?? 0) + 1;
    animationIds.set(element, index);
    const animate = () => requestAnimationFrame(() => {
        if (index !== animationIds.get(element)) return;
        const elapsed = Math.min(performance.now() - start, duration);
        element.scrollTo(scrollLeft + (offsetLeft * elapsed / duration), scrollTop + (offsetTop * elapsed / duration));
        if (elapsed < duration) animate();
        else animationIds.delete(index);
    });
    animate();
};

const determineIfScrolled = (element, x, y, scrollLeft, scrollTop, minimumDistance) => (x === 0 || Math.abs(element.scrollLeft - scrollLeft) > minimumDistance) && (y === 0 || Math.abs(element.scrollTop - scrollTop) > minimumDistance);

export function smoothScroll(element, x, y, accelX=0, accelY=0, minimumDistance=0) {
    let stop = false;
    let prevTime = performance.now();
    const scrollLeft = element.scrollLeft, scrollTop = element.scrollTop;
    const animation = () => requestAnimationFrame(() => {
        if (stop && determineIfScrolled(element, x, y, scrollLeft, scrollTop, minimumDistance)) return;
        const time = performance.now();
        const delta = (time - prevTime) / 1000;
        prevTime = time;
        element.scrollTo(element.scrollLeft + x * delta, element.scrollTop + y * delta);
        x += accelX * delta;
        y += accelY * delta;
        animation();
    });
    animation();
    return () => stop = true;
};

export function createSmoothScroller(target, x, y, accelX, accelY, minimumDistance, text, className) {
    const element = document.createElement("button");
    element.textContent = text || "Scroll";
    if (className) element.className = className;
    element.addEventListener("mousedown", () => {
        const cancelScroll = smoothScroll(target, x, y, accelX, accelY, minimumDistance);
        window.addEventListener("mouseup", cancelScroll, { once: true });
    });
    return element;
};

export async function useTabScrolling(tabSelector) {
    const tabNavigation = tabSelector.parentElement;
    const [width] = await simulateDimensions("span", "term-tab-scroll");
    const tabScrollLeft = createSmoothScroller(tabSelector, -500, 0, -500, 0, width, "←", "term-tab-scroll left");
    const tabScrollRight = createSmoothScroller(tabSelector, 500, 0, 500, 0, width, "→", "term-tab-scroll right");

    let isAnimating = false;
    let rescheduled = {};
    const handleUpdate = (button, position, test) => {
        if (rescheduled[position]) {
            cancelAnimationFrame(rescheduled[position]);
            rescheduled[position] = null;
        }
        if (isAnimating) return rescheduled[position] = requestAnimationFrame(() => handleUpdate(button, position, test));
        const isRooted = tabNavigation.contains(button);
        if (test() > 0) {
            if (!isRooted) {
                tabSelector.insertAdjacentElement(position, button);
                isAnimating = true;
                setTimeout(() => requestAnimationFrame(() => isAnimating = false), BASE_ANIMATION_TIME);
            }
        } else {
            if (!isRooted) return;
            button.classList.add("exit");
            isAnimating = true;
            setTimeout(() => requestAnimationFrame(() => {
                button.classList.remove("exit");
                button.remove();
                if (button === tabScrollLeft) tabSelector.scrollTo(0, 0);
                else tabSelector.scrollTo(tabSelector.scrollWidth - tabSelector.clientWidth, 0);
                isAnimating = false;
            }), BASE_ANIMATION_TIME);
        }
    };
    
    const update = () => {
        handleUpdate(tabScrollLeft, "beforebegin", () => tabSelector.scrollLeft - tabScrollLeft.clientWidth);
        handleUpdate(tabScrollRight, "afterend", () => tabSelector.scrollWidth - tabSelector.scrollLeft - tabSelector.clientWidth - tabScrollRight.clientWidth);
    };
    
    tabSelector.addEventListener("scroll", update);
    new ResizeObserver(update).observe(tabSelector);
}

const COMMAND_HISTORY_LENGTH = 10000;
const KNOWN_MODES = ["default", "irc", "proc"];

const getStoreName = name => name ? `commandHistory-${name}` : `commandHistory`;
const openStore = (db, name, mode="readonly") => {
    const storeName = getStoreName(name);
    const transaction = db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
};

export const initDB = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("terminal", 1);
    request.onupgradeneeded = () => KNOWN_MODES.forEach(mode => 
        request.result.createObjectStore(getStoreName(mode), { autoIncrement: true }));
    request.onsuccess = () => resolve(request.result);
    request.onerror = reject;
});

const getCommandHistory = (db, mode) => new Promise((resolve, reject) => {
    if (!db) resolve([]); // if no db passed, proceed with empty history;
    const store = openStore(db, mode);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = reject;
});

const appendCommandHistory = (text, db, mode) => new Promise((resolve, reject) => {
    if (!db) resolve(); // if no db passed, no action is necessary
    const store = openStore(db, mode, "readwrite");
    const request = store.add(text);
    request.onsuccess = () => {
        const countRequest = store.count();
        countRequest.onsuccess = () => {
            if(countRequest.result > COMMAND_HISTORY_LENGTH) {
                const keyRequest = store.openCursor();
                keyRequest.onsuccess = () => {
                    const deleteRequest = store.delete(keyRequest.result.key);
                    deleteRequest.onsuccess = () => console.debug("command history truncated");
                    deleteRequest.onerror = console.error; // non-fatal error
                };
                keyRequest.onerror = console.error;
            }
        };
        countRequest.onerror = console.error;
        resolve(request.result);
    }
    request.onerror = reject;
});

export async function useHistory(input, db, mode) {
    const commandHistory = await getCommandHistory(db, mode);
    let historyIndex = -1;
    let storedPartialCommand = false;
    const latestCommand = () => commandHistory[commandHistory.length - 1];
    const watchers = new Set();
    return {
        handleEnter() {
            const text = input.value.trim();
            historyIndex = -1;
            if (storedPartialCommand) {
                storedPartialCommand = false;
                commandHistory.pop();
            }
            if (text === latestCommand()) return;
            commandHistory.push(text);
            appendCommandHistory(text, db, mode).catch(console.error);
            watchers.forEach(c => c({ type: "push", text }));
        },
        handleUp() {
            if (historyIndex === -1) {
                const text = input.value.trim();
                if (text !== latestCommand()) {
                    commandHistory.push(text);
                    storedPartialCommand = true;
                }
                historyIndex = commandHistory.length - 1;
            }
            if (historyIndex === 0) return;
            input.value = commandHistory[--historyIndex];
            watchers.forEach(c => c({ type: "navigate", index: historyIndex }));
        },
        handleDown() {
            if (historyIndex !== -1) {
                if (historyIndex < commandHistory.length - 1 - storedPartialCommand) input.value = commandHistory[++historyIndex];
                else {
                    historyIndex = -1;
                    storedPartialCommand = false;
                    input.value = commandHistory.pop();
                }
            }
            watchers.forEach(c => c({ type: "navigate", index: historyIndex }));
        },
        getHistory() {
            return commandHistory.slice(0, commandHistory.length - storedPartialCommand);
        },
        getIndex() {
            return historyIndex;
        },
        watch(callback) {
            watchers.add(callback);
        },
        unwatch(callback) {
            watchers.delete(callback);
        },
        jump(index) {
            if (index === "end" || index === -1) index = commandHistory.length;
            if (index < commandHistory.length - storedPartialCommand) {
                if (historyIndex === -1) {
                    const text = input.value.trim();
                    if (text !== latestCommand()) {
                        commandHistory.push(text);
                        storedPartialCommand = true;
                    }
                }
                input.value = commandHistory[index];
                historyIndex = index;
                watchers.forEach(c => c({ type: "navigate", index }));
            } else {
                historyIndex = -1;
                if (storedPartialCommand) {
                    storedPartialCommand = false;
                    input.value = commandHistory.pop();
                } else input.value = latestCommand();
                watchers.forEach(c => c({ type: "navigate", index: -1 }));
            }
        },
        isLatest() {
            return historyIndex === -1;
        }
    }
}

const createScrollSegment = segment => {
    const element = document.createElement("div");
    element.append(...segment.map(message => createTerminalOutput(message)));
    return element;
};

const SCROLL_SEGMENT_LENGTH = 250;
const SCROLL_HEIGHT_TOLERANCE = 50;
export function useVirtualScrolling(tab) {
    const segments = [];
    let index = 0;

    const newSegment = () => {
        if (segments.length < 2) tab.element.append(createScrollSegment([]));
        segments.push([]);
    };
    newSegment();

    return {
        append(message) {
            if (segments[segments.length - 1].length >= SCROLL_SEGMENT_LENGTH) newSegment();
            segments[segments.length - 1].push(message);
            if (index === segments.length - 2 || segments.length < 3) tab.element.lastChild.append(createTerminalOutput(message));
        },
        update() {
            if (segments.length < 3) return;
            if(tab.element.scrollTop < SCROLL_HEIGHT_TOLERANCE && index) {
                const scrollTop = tab.element.scrollTop;
                const segment = createScrollSegment(segments[--index]);
                tab.element.prepend(segment);
                tab.element.lastChild.remove();
                tab.element.scrollTo(0, scrollTop + segment.scrollHeight);
            } else if (tab.element.scrollHeight - tab.element.scrollTop - tab.element.clientHeight < SCROLL_HEIGHT_TOLERANCE && index + 2 < segments.length) {
                const scrollTo = tab.element.scrollTop - tab.element.firstChild.scrollHeight;
                tab.element.append(createScrollSegment(segments[++index + 1]));
                tab.element.firstChild.remove();
                tab.element.scrollTo(0, scrollTo);
            }
        },
        scrollToTop () {
            if (index > 0) {
                tab.element.replaceChildren(...segments.slice(0, 2).map(createScrollSegment));
                index = 0;
            }
            tab.element.scrollTo(0, 0);
        },
        scrollToBottom() {
            if (segments.length - index > 2) {
                tab.element.replaceChildren(...segments.slice(-2).map(createScrollSegment));
                index = segments.length - 2;
            }
            tab.element.scrollTo(0, tab.element.scrollHeight - tab.element.clientHeight);
        }
    }
}

export function useTimeTravel(eventTypes) {
    const eventHistory = [];
    const watchers = new Set();
    let index = 0;
    let suppressedEvents = new Set();

    const handleRestore = async (operation, index) => {
        const event = eventHistory[index];
        const handler = eventTypes[event.type];
        handler.suppressEvents?.forEach(type => suppressedEvents.add(type));
        try {
            if (handler.restore) await handler.restore(...handler[`${operation}Args`].map(name => event.data[name]), event.data);
            else await handler[operation](event.data);
        } finally {
            handler.suppressEvents?.forEach(type => suppressedEvents.delete(type));
        }
    };

    return {
        pushEvent(type, data) {
            if (!eventTypes[type] || suppressedEvents.has(type)) return;
            if (index < eventHistory.length) {
                eventHistory.splice(index);
                watchers.forEach(c => c({ type: "truncate", index }));
            }
            eventHistory.push({ type, data });
            index = eventHistory.length;
            watchers.forEach(c => c({ type: "push", event: type, data, index }));
        },
        async undo() {
            if (index === 0) return;
            await handleRestore("undo", --index);
            watchers.forEach(c => c({ type: "undo", index }));
        },
        async redo() {
            if (index === eventHistory.length) return;
            await handleRestore("redo", index++);
            watchers.forEach(c => c({ type: "redo", index }));
        },
        async jump(targetIndex) {
            if (targetIndex === "end") targetIndex = eventHistory.length;
            if (targetIndex < 0 || targetIndex > eventHistory.length) return;
            const repeat = () => requestAnimationFrame(() => {
                if (index > targetIndex) this.undo();
                else if (index < targetIndex) this.redo();
                else return;
                requestAnimationFrame(repeat);
            });
            repeat();
        },
        getHistory() {
            return eventHistory; // pretty pls don't mutate🥺
        },
        getIndex() {
            return index;
        },
        isLatest() {
            return index === eventHistory.length;
        },
        watch(callback) {
            watchers.add(callback);
        },
        unwatch(callback) {
            watchers.delete(callback);
        }
    };
}