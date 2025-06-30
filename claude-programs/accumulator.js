import { cp } from "../base.js";

cp("accumulator", {
    init() {
        this.concepts = new Map();
        this.nextId = 0;
        this.broadcastConcepts = () => {
            const data = Array.from(this.concepts.values()).map(c => ({
                id: c.id, content: c.content, tag: c.tag,
                refs: Array.from(c.refs), created: c.created
            }));
            this.share({ key: "accumulator_concepts", data, target: "picker" });
        };
        this.broadcastConcepts();
        this.send("Accumulator initialized. Commands: add, link, find, dump");
    },

    update(parsedCommand, shared = null) {
        if (shared) return; // accumulator doesn't consume shared data
        
        if (!parsedCommand?.type) return;
        
        const { type: cmd, args } = parsedCommand;
        const changed = ["add", "link"].includes(cmd);
        
        switch(cmd) {
            case "add":
                const [tag = "concept", ...content] = args;
                const obj = {
                    id: this.nextId++,
                    content: content.join(" "),
                    tag,
                    refs: new Set(),
                    created: Date.now()
                };
                this.concepts.set(obj.id, obj);
                this.send(`Added: [${obj.id}] ${obj.content} (${obj.tag})`);
                break;
                
            case "link":
                const [fromId, toId] = args.map(Number);
                const from = this.concepts.get(fromId);
                const to = this.concepts.get(toId);
                if (from && to) {
                    from.refs.add(toId);
                    to.refs.add(fromId);
                    this.send(`Linked: ${fromId} <-> ${toId}`);
                } else {
                    this.send("Invalid IDs");
                }
                break;
                
            case "find":
                const text = args.join(" ");
                const matches = Array.from(this.concepts.values()).filter(obj => 
                    obj.content.toLowerCase().includes(text.toLowerCase()) || obj.tag === text
                );
                matches.forEach(obj => {
                    const refList = Array.from(obj.refs).join(",");
                    this.send(`[${obj.id}] ${obj.content} (${obj.tag}) refs: ${refList}`);
                });
                break;
                
            case "dump":
                this.concepts.forEach(obj => {
                    const refList = Array.from(obj.refs).join(",");
                    this.send(`[${obj.id}] ${obj.content} (${obj.tag}) refs: ${refList}`);
                });
                break;
        }
        
        if (changed) this.broadcastConcepts();
    }
}, "relational concept storage with tagging and references");