import { applyStyle, build, Component, createRoot, mount } from "../ui/builder.js";
import createState, { shallow } from "../ui/state.js";

function prettifyEvent(type, data) {
    switch (type) {
        case "tabChange":
            return `${data.previous.name} -> ${data.current.name}`;
        case "tabPositionChange":
            return `${data.tab.name} [${data.previous + 1} -> ${data.current + 1}]`;
        case "tabSwap":
            return `${data.a} <-> ${data.b}`;
        case "tabClose":
            return `(-) ${data.tab.name}`;
        case "tabRestore":
            return `(+) ${data.tab.name}`;
        case "tabMerge":
            return `${data.tabs.map(t => t.name).join(", ")} -> ${data.name}`
        default:
            return "unknown event";
    }
}

function historyList(watchable, updateHandler, store) {
    watchable.watch(updateHandler);
    const root = new Component({
        tag: "table"
    }).on("destroy", () => watchable.unwatch(updateHandler));

    const { state, reactive, reactiveList } = store.scopeTo(root);
    reactiveList(({ type, data }, index) => {
        new Component({
            tag: "tr",
            className: "history-entry",
            children: [
                {
                    tag: "td",
                    textContent: `${index + 1}: ${type}`,
                    className: "history-type",
                    "data-history": index
                },
                data && {
                    tag: "td",
                    textContent: prettifyEvent(type, data),
                    className: "history-description"
                }
            ],
            onclick: () => watchable.jump(index)
        }).mount(root);
    }, state.history);

    reactive(function(index) {
        root.queryBy("history", this.prev)?.classList.remove("active");
        root.queryBy("history", index)?.classList.add("active");
        if (!watchable.isLatest()) {
            new Component({
                tag: "tr",
                className: "history-entry",
                children: [
                    {
                        tag: "td",
                        textContent: `Jump to Latest`,
                        className: "jump"
                    }
                ],
                onclick: () => watchable.jump("end")
            }).mount(root);
        }
    }, state.index);
    return root;
}

function clientHistoryView({ stateManager }) {
    history.shallow = true;
    const store = createState({
        history: shallow(stateManager.getHistory()), index: stateManager.getIndex()
    });
    const state = store.state;
    const updateHandler = ({ type, ...data }) => {
        if (type === "undo" || type === "redo") state.index = data.index;
        else if (type === "push") {
            state.history.push({ type: data.event, data: data.data });
            state.index = data.index;
        } else if (type === "truncate") state.history.splice(data.index);
    };

    return historyList(stateManager, updateHandler, store);
}

function commandHistoryView({ state: s, stateManager }) {
    const getTabs = () => s.tabList.map(({ mode, name, tabs }) => ({ mode, name, tabs }));

    const activeTab = s.tabs.get("default") ?? s.activeTab;
    const store = createState({
        tabs: getTabs(),
        activeTab: activeTab.mode,
        history: shallow(activeTab.history.getHistory().map(text => ({ type: text }))),
        index: activeTab.history.getIndex()
    });
    const { state, reactive, reactiveList } = store;

    const updateHistory = mode => {
        const history = s.tabs.get(mode).history;
        state.history = history.getHistory().map(text => ({ type: text }));
        state.index = history.getIndex();
    };

    const tabUpdater = ({ event, data }) => {
        if (event === "tabChange") state.activeTab = data.current.mode;
        else state.tabs = getTabs();
    }

    stateManager.watch(tabUpdater);

    const root = new Component({
        tag: "div"
    }).on("destroy", () => stateManager.unwatch(tabUpdater));

    const tabList = new Component({
        tag: "span",
        className: "tab-list"
    }).mount(root);

    reactiveList((tab, index) => {
        const render = ({ name, mode }, i) => {
            if (i > 0) mount(build("|"), tabList);
            new Component({
                tag: "a",
                className: "tab-anchor",
                textContent: name,
                "data-mode": mode,
                onclick: () => state.activeTab = mode
            }, true).mount(tabList);
        };
        const renderDeep = (tab, i) => {
            console.log(tab.name);
            if (tab.tabs) tab.tabs.forEach(renderDeep);
            else render(tab, index + i);
        };
        renderDeep(tab, index);
    }, state.tabs);

    const updateHandler = ({ type, ...data }) => {
        if (type === "navigate") state.index = data.index;
        else if (type === "push") {
            state.history.push({ type: data.text });
            state.index = -1;
        }
    };

    reactive(function (mode) {
        if (this.prev !== mode) tabList.queryBy("mode", this.prev)?.classList.remove("active");
        tabList.queryBy("mode", mode)?.classList.add("active");
        updateHistory(mode);
        historyList(s.tabs.get(mode).history, updateHandler, store)
            .set("style", { marginBottom: "1.5rem" }).mount(root);
    }, state.activeTab);

    return root;
}

export default function createHistoryView(type, data) {
    const root = createRoot(build({ tag: "div" }));
    let view;
    if (type === "client") view = clientHistoryView(data);
    if (type === "command") view = commandHistoryView(data);
    mount(view, root);
    applyStyle(root, "programs/style/historyView.css");
    return root;
};