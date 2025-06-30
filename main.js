import { Worker } from "worker_threads";
import express from "express";
import { Server } from "socket.io";
const app = express();
const port = 3000;

app.use(express.static('public', { index: ["index.html"] }));
const server = app.listen(port, () => console.log(`App listening on port ${port}`));

const io = new Server();

const HELP_MESSAGES = {
    "echo": ["echo <message>", "Sends message to output."],
    "ping": ["ping", "pong."],
    "help": ["help", "Returns this help information."],
    "run": ["run <name> [...args]", "Launches a process in a new tab."],
    "list-programs": ["list-programs", "Lists available programs."],
    "history": ["history server|client|command", "View history relevant to specific parts of the terminal."]
};

const HELP_LIST = Object.values(HELP_MESSAGES);
const MAX_HELP_LENGTH = HELP_LIST.reduce((a, b) => Math.max(a, b[0].length), 0);
const HELP_STRING = HELP_LIST.map(entry => entry[0] + " ".repeat(MAX_HELP_LENGTH - entry[0].length) + " | " + entry[1]).join("\n");

import { programs, registerProgram } from "./base.js";
import "./claude-programs/accumulator.js";
import "./claude-programs/picker.js";

const sessionData = new Map();
function handleProc(socket, data, op) {
    if (!data.payload) data.payload = [];
    const session = sessionData.get(socket.id);
    const cleanupOnExit = (process, reason) => {
        if (!process.worker) return;
        process.worker.terminate();
        process.worker = null;
        session.activeProcesses.delete(process.name);
        socket.emit("proc:exit", { name: process.name, PID: process.PID });
        send(socket, `Process '${process.title}' (PID ${process.PID}) has exited.${ reason ? reason.length > 50 ? `\nReason: ${reason}` : ` (Reason: ${reason})` : ""}`);
    };
    switch (op) {
        case "init":
            const procObject = programs.get(data.name);
            if (procObject) {
                const process = {
                    name: procObject.name,
                    title: procObject.title ?? procObject.name,
                    PID: procObject.PID,
                    send(text) { send(socket, text, this.name, this.PID) },
                    sendDefault(text) { send(socket, text) },
                    sendEvent(type, data) { socket.emit(`proc:event`, { type, data, name: this.name, PID: this.PID }) },
                    call(hook, payload={}) { handleProc(socket, { name: `${this.name}-${this.PID}`, payload }, hook) },
                    example(text) { return `Callback, bitch. ${text}` },
                    share(data) { this.sendEvent("share", data) }
                };
                if (!procObject.callables) procObject.callables = new Map(Object.entries(process).filter(([_, v]) => typeof v === "function").map(([name, f]) => [name, f.toString().includes("return")]));
                process.worker = new Worker("./processWorker.js", { workerData: procObject });
                procObject.PID++;
                process.worker.on("message", async data => {
                    switch (data.type) {
                        case "call":
                            if (!data.name || !procObject.callables.has(data.name)) return;
                            if (!Array.isArray(data.args)) data.args = [data.args];
                            const result = await process[data.name](...data.args);
                            if (data.id) process.worker.postMessage({ type: "callback", name: data.name, id: data.id, result });
                            break;
                        case "exit":
                            cleanupOnExit(process);
                            break;
                    }
                });
                process.worker.on("exit", () => cleanupOnExit(process));
                process.worker.on("error", error => cleanupOnExit(process, error.message))
                session.activeProcesses.set(`${data.name}-${process.PID}`, process);
                socket.emit("proc:spawn", { name: process.name, title: process.title, PID: process.PID });
                send(socket, `Process '${process.title}' (PID ${process.PID}) is running in a new tab.`);
                process.worker.postMessage({ type: "call", name: "init", payload: data.payload });
            } else send(socket, `Program name '${data.name}' is not recognized.\nType 'list-programs' to see available options.`);
            break;
        case "update":
        case "share":
            session.activeProcesses.get(data.name)?.worker.postMessage({ type: op === "share" ? "share" : "call", name: op, payload: data.payload });
            break;
        case "destroy": {
            const process = session.activeProcesses.get(data.name);
            if (!process) return;
            process.worker?.postMessage({ type: "call", name: "destroy", payload: data.payload });
            setTimeout(() => cleanupOnExit(process, "Process stopped responding while closing."), 1000); // process get 1 second to terminate
        }
    }  
}

const send = (socket, text, mode="default", PID) => socket.emit("terminal:output", {
    text,
    mode: mode + (PID ? "-" + PID : ""),
    timestamp: Date.now()
});

io.on("connection", (socket) => {
    console.log(`socket ${socket.id} connected`);
    const session = { activeProcesses: new Map() };
    sessionData.set(socket.id, session);

    const output = text => send(socket, text);

    socket.on("default:command", data => {
        switch(data.type) {
            case "echo":
                output(data.args.join(" "));
                break;
            case "ping":
                output("pong.");
                break;
            case "list-programs":
                send(socket, "Available programs:");
                programs.forEach(program => send(socket, `${program.name}: ${program.description}`));
                break;
            case "history":
                break;
            default:
                output(HELP_STRING);
        }
    });

    socket.on("proc:init", data => handleProc(socket, data, "init"));
    socket.on("proc:update", data => handleProc(socket, data, "update"));
    socket.on("proc:destroy", data => handleProc(socket, data, "destroy"));
    socket.on("proc:share", data => handleProc(socket, data, "share"));

    socket.on("disconnect", (reason) => {
        session.activeProcesses.forEach(process => process.call("destroy"));
        sessionData.delete(socket.id);
        console.log(`socket ${socket.id} disconnected due to ${reason}`);
    });
});

registerProgram("test", {
    async init(timeout) {
        console.log(await this.example("Worker was here."));
        timeout = parseInt(timeout);
        if (isNaN(timeout)) throw new Error("Invalid argument (or none) passed to program 'test'.");
        this.send("Welcome to the test process.");
        this.state.count = 0;
        this.state.timer = setInterval(() => { this.send((++this.state.count).toString()) }, timeout);
        this.sendEvent("setTabTitle", `Test Process (${this.PID})`);
    },
    destroy() {
        clearInterval(this.state.timer);
    }
}, "A program to test process functionality. Prints at specified interval (milliseconds)");

registerProgram("clock", {
    init() {
        this.send("A simple clock program.\nEver heard of a clock tab before? Now you have.");
        const getTime = () => new Date().toLocaleTimeString();
        this.sendEvent("setTabTitle", getTime());
        this.state.timer = setInterval(() => this.sendEvent("setTabTitle", getTime()), 1000);
    },
    destroy() {
        this.sendEvent("setTabTitle", "Clock (Dead)");
        clearInterval(this.state.timer);
    }
}, "A clock");
  
io.listen(server);