import { parseCommand, createTab, initDB, createScrollButton, useTimeTravel, useTabScrolling, BASE_ANIMATION_TIME, createGroup } from "./helpers.js";
import createHistoryView from "./programs/historyView.js";
import { destroy, mount } from "./ui/builder.js";

const socket = io();
const db = await initDB();

// why tf do I have to manually hoist this shit?
const updateScrollButton = () => {
    const el = state.activeTab.element;
    if (Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) > 25) {
        if (state.scrollButton) return;
        state.scrollButton = createScrollButton(state.activeTab);
        root.append(state.scrollButton);
    }
    else if (state.scrollButton) {
        state.scrollButton.remove();
        state.scrollButton = null;
    }
}

const state = {
    tabs: new Map(),
    tabList: [],
    closedTabs: [],
    activeTab: null,
    pendingMerge: new Set(),
    resizeObserver: new ResizeObserver(updateScrollButton)
};

const stateManager = useTimeTravel({
    tabChange: {
        undoArgs: ["previous"],
        redoArgs: ["current"],
        suppressEvents: ["tabChange"],
        restore(tab) {
            setActiveTab(tab);
        }
    },
    tabPositionChange: {
        undoArgs: ["tab", "previous"],
        redoArgs: ["tab", "current"],
        restore(tab, index) {
            const tabs = state.tabList;
            const currentIndex = tabs.findIndex(x => x === tab);
            tabs.splice(currentIndex, 1);
            tabs.splice(index, 0, tab);
            updateTabUI();
        }
    },
    tabSwap: {
        undoArgs: ["a", "b"],
        redoArgs: ["a", "b"],
        restore(a, b) {
            const tabs = state.tabList;
            const tab = tabs[a];
            tabs[a] = tabs[b];
            tabs[b] = tab;
            updateTabUI();
        }
    },
    tabClose: {
        suppressEvents: ["tabClose", "tabRestore", "tabChange"],
        undo({ tab, index, wasActive }) {
            restoreTab(tab, index, wasActive);
        },
        async redo({ tab }) {
            await closeTab(tab);
        }
    },
    tabRestore: {
        suppressEvents: ["tabRestore", "tabClose", "tabChange"],
        async undo({ tab }) {
            await closeTab(tab);
        },
        redo({ tab, index, wasActive }) {
            restoreTab(tab, index, wasActive);
        }
    },
    tabMerge: {
        suppressEvents: ["tabMerge", "tabClose", "tabChange"],
        async undo(group) {
            await closeTab(group, true);
        },
        redo(group) {
            mergeTabs(group);
            group.tabs.forEach((t, i) => {
                const panes = group.element.querySelectorAll(`[data-tabindex="${i}"]`);
                for (const pane of panes) if (pane.parentElement.parentElement === group.element) {
                    pane.replaceChildren(t.element);
                    break;
                }
            });
        }
    }
});

const root = document.getElementById("terminal-root");
root.className = "term-root";

const titleBar = document.createElement("header");
titleBar.className = "term-header";

const title = document.createElement("span");
title.textContent = "A terminal window";
title.className = "term-title";

const infoText = document.createElement("span");
infoText.textContent = "Ctrl+Click to close tabs";
infoText.className = "term-tab-info";

const divider = document.createElement("div");
divider.className = "term-div";

const tabNavigation = document.createElement("nav");
tabNavigation.className = "term-tab-nav basic";

const tabSelector = document.createElement("menu");
tabSelector.className = "term-tabs";

tabNavigation.append(tabSelector);
titleBar.append(title, infoText, divider, tabNavigation);

const output = document.createElement("div");
output.className = "term-display";

const handleScroll = tab => {
    if (tab.tabs) return tab.tabs.forEach(handleScroll);
    // vomits all over keyboard
    if (!tab) return;
    const el = tab.element;
    if (!document.contains(el)) return;
    if (Math.abs(tab.previousHeight - el.clientHeight - tab.previousScroll) < 25
        || tab.previousHeight < el.clientHeight)
        el.scrollTo(0, el.scrollHeight - el.clientHeight);
    else el.scrollTo(0, tab.previousScroll);
    tab.scrollback.update();
    tab.previousScroll = el.scrollTop;
    tab.previousHeight = el.scrollHeight;
};

const print = data => {
    const relevantTab = data.mode ? state.tabs.get(data.mode + (data.PID ? "-" + data.PID : "")) : state.tabs.get("default");
    relevantTab?.scrollback.append(data.text !== undefined ? data : { text: data });
    handleScroll(relevantTab);
}

const cls = () => {
    for (const segment of state.activeTab.element.children) segment.replaceChildren();
    print("Screen cleared.");
}

const programs = new Map();
const activeProcesses = new Map();

function registerProgram(name, handlers, description) {
    const program = {
        name,
        PID: -1,
        handlers,
        description: description || "No description"
    };
    programs.set(name, program);
}

const genericProcessExit = async ({ name, PID }) => {
    const tab = state.tabs.get(`${name}-${PID}`);
    if (!tab) return;
    tab.PID = null;
    tab.isDead = true;
    await closeTab(tab);
};

const initClientProcess = async (options, ...args) => {
    const name = (typeof options === "string" ? options : options.name) || "unknown";
    const procObject = programs.get(name);
    if (!procObject) return;
    const process = {
        name: procObject.name,
        title: options.title ?? procObject.title ?? procObject.name,
        PID: procObject.PID--,
        init: () => {},
        update: () => {},
        destroy: () => {}
    };
    for (let [name, f] of Object.entries(procObject.handlers)) {
        if (name === "init") {
            async function init(...args) {
                const mode = `${this.name}-${this.PID}`;
                this.tab = await newTab(this.title, mode, this.PID);
                print(`Process '${this.title}' (PID ${this.PID}) is running in a new tab.`);
                activeProcesses.set(mode, this);
                return await procObject.handlers.init.apply(this, args);
            };
            f = init;
        } else if (name === "destroy") {
            async function destroy(...args) {
                await genericProcessExit({ name: this.name, PID: this.PID });
                activeProcesses.delete(`${this.name}-${this.PID}`);
                return await procObject.handlers.destroy.apply(this, args);
            };
            f = destroy;
        }
        process[name] = f.bind(process);
    }
    await process.init(...args);
    return process;
};

const destroyClientProcess = async mode => await activeProcesses.get(mode)?.destroy();

registerProgram("render", {
    init(renderFunc) {
        this.uiHandle = renderFunc();
        mount(this.uiHandle, this.tab.element);
    },
    destroy() {
        destroy(this.uiHandle);
    }
}, "UI Component Process");

const processCommand = async (command, mode) => {
    if (mode !== "default") return;
    switch (command.type) {
        case "run":
            const [name, ...args] = command.args;
            if (!name) return;
            socket.emit("proc:init", {
                name, payload: args
            });
            return true;
        case "history":
            const [mode] = command.args;
            if (mode === "server") return;
            await initClientProcess({ name: "render", title: `History (${mode})` }, () => createHistoryView(mode, { state, stateManager }));
            return true;
    }
};

const defaultCommandModes = new Set(["default", "irc"]);
const validCommands = new Set(["echo", "ping", "help", "run", "list-programs", "history"]);
const commandValidators = {
    "default": type => validCommands.has(type),
    "irc": () => true
};

const inputLine = document.createElement("span");
inputLine.className = "term-input";
const prefix = document.createElement("span");
prefix.className = "term-prefix";
const input = document.createElement("input");
inputLine.append(prefix, input);

const directionMap = { Left: -1, Right: 1 };
window.addEventListener("keydown", async ev => {
    if (ev.key === "Enter") {
        ev.preventDefault();
        const text = input.value.trim();
        if (!text.length) return;
        state.activeTab.history.handleEnter();
        print({ text: `> ${text}`, mode: state.activeTab.mode, style: "muted" });
        const mode = getActiveTab().mode;
        if (defaultCommandModes.has(mode)) {
            const parsedCommand = parseCommand(text, commandValidators[mode]);
            // this can be made far more robust
            if (parsedCommand) {
                if (!await processCommand(parsedCommand, mode))
                    socket.emit(`${mode}:command`, parsedCommand);
            } else print({ text: "Invalid command. Type help for a list of commands.", mode: state.activeTab.mode  });
        }
        activeProcesses.get(mode)?.update("input", text);
        input.placeholder = text;
        input.value = "";
    } else if (ev.key.startsWith("Arrow")) {
        const dir = ev.key.slice(5);
        if (dir === "Up" || dir === "Down") {
            ev.preventDefault();
            state.activeTab.history[`handle${dir}`]();
        } else if (ev.ctrlKey) {
            if (document.activeElement === input) return;
            const [Left, Right, index] = activeTabNeighbors();
            const tab = { Left, Right }[dir];
            if (!tab) return;
            if (ev.shiftKey) {
                const targetIndex = index + directionMap[dir];
                state.tabList[index] = tab;
                state.tabList[targetIndex] = state.activeTab;
                updateTabUI();
                stateManager.pushEvent("tabSwap", { a: index, b: targetIndex });
            } else setActiveTab(tab);
        }
    } else if (ev.key === "Escape") {
        if (document.activeElement === input) {
            input.blur();
            state.activeTab.element.focus();
        }  else input.focus();
    } else if (ev.key === " " && ev.ctrlKey) {
        const cl = tabNavigation.classList;
        const swap = () => {
            if (cl.contains("basic")) cl.replace("basic", "columnar");
            else cl.replace("columnar", "basic");
        };
        const floatingTab = document.querySelector(".floating");
        if (!floatingTab) return swap();
        const style = floatingTab.style;
        const { x: px, y: py } = floatingTab.getBoundingClientRect();
        const { x, y } = floatingTab.getBoundingClientRect();
        style.left = `${parseFloat(style.left.slice(0, -2)) + px - x}px`;
        style.top = `${parseFloat(style.top.slice(0, -2)) + py - y}px`;
    } else if (document.activeElement !== input) {
        const home = ev.key === "Home";
        if (ev.key === "End" || home) {
            ev.preventDefault();
            state.activeTab.scrollback[ev.shiftKey ^ home ? "scrollToTop" : "scrollToBottom"]();
        } else if (ev.key === "Delete") {
            if (ev.shiftKey) restoreTab()
            else await closeTab(state.activeTab);
        } else if (ev.ctrlKey) {
            ev.preventDefault();
            if (ev.key === "z") await stateManager.undo();
            else if (ev.key === "y") await stateManager.redo();
        }
    }
});

window.addEventListener("keyup", ev => {
    if (ev.key === "Shift" && state.pendingMerge.size) {
        mergeTabs([state.activeTab, ...Array.from(state.pendingMerge)]);
        state.pendingMerge.clear();
    }
});

const tabDisplayMode = () => tabNavigation.classList.item(1);

await useTabScrolling(tabSelector);
const updateTabUI = () => {
    tabSelector.replaceChildren(...state.tabList.map(tab => {
        const selector = document.createElement("a");

        selector.href = "#" + tab.mode;
        selector.textContent = tab.name;
        selector.className = "term-tab-anchor";
        /* selector.style.color = tab.color; */ // will make this an option once configuration is available
        selector.addEventListener("click", async ev => {
            if (!snapped) ev.preventDefault();
            else if (ev.ctrlKey) {
                console.log("yea what?");
                await closeTab(tab);
                ev.preventDefault();
            } else if (ev.shiftKey && tab !== state.activeTab) {
                state.pendingMerge.add(tab);
                selector.classList.add("active");
                ev.preventDefault();
            }
        });
        if (tab === state.activeTab) selector.classList.add("active");

        // drag and drop
        const TOLERANCE = 16; //px
        let origin, width, snapped = true, caret, after, target;
        const clearInsertion = () => {
            if (!caret) return;
            caret.remove();
            caret = null;
            after = null;
            target = null;
        };
        selector.addEventListener("mousedown", ev => {
            if (ev.target !== selector) return;
            origin = { x: ev.clientX, y: ev.clientY };
            width = selector.getBoundingClientRect().width;
            const onmousemove = ev => {
                if (!(ev.buttons & 1)) return onmouseup();
                const isColumnar = tabDisplayMode() === "columnar";
                const offset = {
                    x: ev.clientX - origin.x, 
                    y: ev.clientY - origin.y
                };
                if (Math.max(Math.abs(offset.x), Math.abs(offset.y)) > 5) {
                    if (snapped) {
                        snapped = false;
                        const position = { x: selector.offsetLeft - tabSelector.scrollLeft, y: selector.offsetTop };
                        selector.style.width = `${width}px`;
                        selector.style.position = "absolute";
                        selector.style.left = `${position.x}px`;
                        selector.style.top = `${position.y}px`;
                        selector.classList.add("floating");
                    }
                    selector.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
                    let side, targetElement;
                    const e = isColumnar ? ev.clientX - tabNavigation.offsetLeft : ev.clientY;
                    const o = selector[isColumnar ? "offsetLeft" : "offsetTop"];
                    const s = selector[isColumnar ? "offsetWidth" : "offsetHeight"];
                    if (e < o - TOLERANCE || e > o + s + TOLERANCE) return clearInsertion();
                    const v = (isColumnar ? ev.clientY - tabNavigation.offsetTop : ev.clientX) + tabSelector[isColumnar ? "scrollTop" : "scrollLeft"];
                    const _c = isColumnar ? "offsetTop" : "offsetLeft";
                    const _s = isColumnar ? "offsetHeight" : "offsetWidth";
                    for  (const child of tabSelector.children) {
                        if (child === selector || !child.href) continue;
                        const c = child[_c];
                        const s = child[_s];
                        if (v > c - TOLERANCE && v < c + s + TOLERANCE) {
                            side = v > c + s * .5;
                            targetElement = child;
                            break;
                        }
                    }
                    if (targetElement) {
                        if (after !== undefined && side === after && targetElement === target) return;
                        target = targetElement;
                        if (caret) caret.remove();
                        after = side;
                        caret = document.createElement("span");
                        caret.textContent = "█";
                        caret.style.marginLeft = ".25rem";
                        caret.style.color = "#ccc";
                        target.insertAdjacentElement(after ? "afterend" : "beforebegin", caret);
                    } else clearInsertion();
                }
            };
            const onmouseup = () => {
                window.removeEventListener("mousemove", onmousemove);
                origin = null;
                selector.style.transform = "";
                selector.style.width = "";
                selector.style.position = "";
                selector.style.left = "";
                selector.style.top = "";
                selector.classList.remove("floating");
                setTimeout(() => snapped = true, 0);
                if (!caret) return;
                const targetMode = target.href.slice(target.href.indexOf("#") + 1);
                const index = state.tabList.findIndex(x => x === tab);
                const targetIndex = state.tabList.findIndex(x => x.mode === targetMode) + after;
                const adjustedSpliceTarget = targetIndex - (index < targetIndex);
                if (index === adjustedSpliceTarget) return clearInsertion();
                state.tabList.splice(index, 1);
                state.tabList.splice(adjustedSpliceTarget, 0, tab);
                selector.remove();
                target.insertAdjacentElement(after ? "afterend" : "beforebegin", selector);
                stateManager.pushEvent("tabPositionChange", { tab, previous: index, current: adjustedSpliceTarget });
                clearInsertion();
            };
            window.addEventListener("mousemove", onmousemove);
            window.addEventListener("mouseup", onmouseup, { once: true });
        });
        selector.addEventListener("dragstart", ev => ev.preventDefault());

        return selector;
    }));
}

let pa = {};
const animateTabChange = (prev, next) => {
    if (!document.contains(prev.element)) return;
    if (pa.interval) {
        output.classList.remove(pa.style);
        pa.element.remove();
        clearTimeout(pa.interval);
        pa = {};
    }
    setTimeout(() => {
        let left = false;
        for (const t of state.tabList) {
            if (t === prev) { left = true; break; }
            if (t === next) { break; }
        }
        const exit = `exit-${left ? "left" : "right"}`;
        output.classList.add(exit);
        output[left ? "append" : "prepend"](next.element);
        pa.style = exit;
        pa.element = prev.element;
        pa.interval = setTimeout(() => {
            output.classList.remove(exit);
            prev.element.remove();
        }, BASE_ANIMATION_TIME);
    }, 0);
};

const getPrefixText = ({ mode }) => {
    // this can be much fancier eventually
    const i = mode.indexOf("-");
    if (i === -1) return mode;
    return mode.slice(0, i);
};

const updatePrefix = (tab, flushInput=true) => {
    prefix.style.color = tab.color;
    prefix.textContent = getPrefixText(tab);
    if (!flushInput) return;
    input.value = tab.partialInput ?? "";
};

const getActiveTab = () => {
    let activeTab = state.activeTab;
    while(activeTab.activeTab) activeTab = activeTab.activeTab;
    return activeTab;
}

const setActiveTab = (tab, addToHistory=true, asMerge=false) => {
    if (!tab) history.replaceState(defaultTab.mode, "", "#" + defaultTab.mode);
    tab = tab || defaultTab;
    if (!tab || tab === state.activeTab) return;
    state.resizeObserver.observe(tab.element);
    if (state.activeTab) {
        state.resizeObserver.unobserve(state.activeTab.element);
        getActiveTab().partialInput = input.value;
        if (asMerge) {
            if (!tab.element.contains(state.activeTab.element)) state.activeTab.element.remove();
            output.append(tab.element);
        }
        else {
            animateTabChange(state.activeTab, tab);
            stateManager.pushEvent("tabChange", { previous: state.activeTab, current: tab });
        }
    }
    else output.append(tab.element);
    input.disabled = tab.isDead;
    state.activeTab = tab;
    if (addToHistory) history[addToHistory === "replace" ? "replaceState" : "pushState"](tab.mode, "", "#" + tab.mode);
    if (state.scrollButton) {
        state.scrollButton.remove();
        state.scrollButton = null;
    }
    updatePrefix(tab.activeTab ?? tab);
    updateTabUI();
    setTimeout(() => {
        handleScroll(tab);
        updateScrollButton();
    }, 0);
};

const activeTabNeighbors = () => {
    const index = state.tabList.findIndex(x => x === state.activeTab);
    return [state.tabList[index - 1], state.tabList[index + 1], index];
};

const closeTab = async (tab, asHistory=false) => {
    if (tab.mode === "default" && state.tabs.size === 1) return cls();
    if (tab.PID > 0) return socket.emit("proc:destroy", { name: tab.mode, PID: tab.PID });
    if (tab.PID < 0) return await destroyClientProcess(tab.mode);
    const wasActive = tab === state.activeTab;
    if (wasActive && !tab.tabs) {
        const [prev, next] = activeTabNeighbors();
        setActiveTab(prev || next || await newTab("Default Shell", "default"), "replace");
    }
    const index = state.tabList.findIndex(x => x === tab);
    if (tab.tabs) {
        [...tab.tabs].sort((a, b) => a.slot - b.slot).forEach(tab => {
            state.tabList.splice(tab.slot, 0, tab);
            delete tab.slot;
        });
        setActiveTab(asHistory ? tab.initiator : tab.activeTab, true, true);
    } else state.closedTabs.push({ tab, index, wasActive });
    state.tabs.delete(tab.mode);
    state.tabList.splice(index, 1);
    updateTabUI();
    stateManager.pushEvent("tabClose", { tab, index, wasActive });
};

const insertExistingTab = (tab, index) => {
    state.tabs.set(tab.mode, tab);
    if (index !== undefined) state.tabList.splice(index, 0, tab);
    else state.tabList.push(tab);
    updateTabUI();
};

const mergeTabs = list => {
    const tabs = list.tabs ?? list;
    const test = new Set(tabs.map(t => t.mode));
    const hasActiveTab = test.has(state.activeTab.mode);
    const tabList = [];

    let slot = null, c = 0;
    for (let i = 0; i < state.tabList.length; i++) {
        const tab = state.tabList[i];
        if (!test.has(tab.mode)) {
            tabList.push(tab);
            c++;
            continue;
        }
        if (tab === state.activeTab) {
            tabList.push(null);
            slot = c;
        }
        tab.slot = i;
    }

    const group = list.tabs ? list : createGroup(null, tabs, hasActiveTab ? state.activeTab : null, updatePrefix);
    tabList[slot] = group;

    state.tabList = tabList;
    state.tabs.set(group.mode, group);
    stateManager.pushEvent("tabMerge", group);
    if (hasActiveTab) setActiveTab(group, true, true);
}

const restoreTab = (tab, index, wasActive) => {
    if(tab) state.closedTabs.splice(state.closedTabs.findIndex(x => x.tab === tab), 1);
    else {
        const info = state.closedTabs.pop();
        if (!info) return;
        tab = info.tab, index = info.index; wasActive = info.wasActive;
    }
    if (!tab || (tab.mode === "default" && state.tabs.has("default"))) return;
    insertExistingTab(tab, index);
    stateManager.pushEvent("tabRestore", { tab, index });
    if (wasActive) setActiveTab(tab);
};

const newTab = async (name, mode, PID) => {
    const tab = await createTab(name, mode, input, PID ? null : db);
    tab.PID = PID;
    const el = tab.element;
    el.addEventListener("scroll", ev => {
        tab.scrollback.update(ev);
        tab.previousScroll = tab.element.scrollTop;
        tab.previousHeight = tab.element.scrollHeight;
        updateScrollButton();
    });
    insertExistingTab(tab);
    return tab;
};

const defaultTab = await newTab("Default Shell", "default");
await newTab("IRC", "irc");
setActiveTab(state.tabs.get(location.hash.substring(1)), false);

window.addEventListener("hashchange", () => setActiveTab(state.tabs.get(location.hash.substring(1)), false));
window.addEventListener("keydown", ev => ev.key === "Control" && tabSelector.classList.add("invert"));
window.addEventListener("keyup", ev => ev.key === "Control" && tabSelector.classList.remove("invert"));
window.addEventListener("click", () => setTimeout(() => document.getSelection().type === "Range" || input.focus(), 0));

root.append(titleBar, output, inputLine);

socket.on("terminal:output", print);
socket.on("proc:spawn", async ({ name, title, PID }) => await newTab(title, `${name}-${PID}`, PID));
socket.on("proc:exit", genericProcessExit);
socket.on("proc:event", ({ type, data, name, PID }) => {
    const mode = `${name}-${PID}`;
    const tab = state.tabs.get(mode);
    if (!tab) return;
    switch (type) {
        case "setTabTitle":
            tab.name = data;
            //janky but (relatively) efficient method (instead of updateTabUI)
            const tabAnchor = tabSelector.querySelector(`[href="#${mode}"]`)
            if (tabAnchor) tabAnchor.textContent = data;
            break;
    }
});

setTimeout(() => input.focus(), 0);