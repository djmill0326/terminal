import { cp } from "../base.js";

cp("picker", {
    init() {
        this.concepts = [];
        this.flattenConcept = concept => {
            const refs = concept.refs.map(id => {
                const ref = this.concepts.find(c => c.id === id);
                return ref ? `${ref.content}(${ref.tag})` : `#${id}`;
            }).join(", ");
            return `[${concept.id}] ${concept.content} (${concept.tag})${refs ? ` -> ${refs}` : ""}`;
        };
        this.send("Picker initialized. Commands: pick <id|term>, random [tag]");
    },

    update(parsedCommand, shared = null) {
        if (shared?.key === "accumulator_concepts") {
            this.concepts = shared.data;
            this.send(`Synced ${this.concepts.length} concepts`);
            return;
        }
        
        if (!parsedCommand?.type) return;
        
        const { type, args } = parsedCommand;
        
        switch(type) {
            case "pick":
                const query = args.join(" ");
                const isId = !isNaN(parseInt(query));
                
                if (isId) {
                    const concept = this.concepts.find(c => c.id === parseInt(query));
                    this.send(concept ? this.flattenConcept(concept) : "Not found");
                } else {
                    const matches = this.concepts.filter(c => 
                        c.content.toLowerCase().includes(query.toLowerCase()) || c.tag === query
                    );
                    if (matches.length) {
                        const picked = matches[Math.floor(Math.random() * matches.length)];
                        this.send(this.flattenConcept(picked));
                    } else {
                        this.send("No matches");
                    }
                }
                break;
                
            case "random":
                const tag = args[0];
                const candidates = tag ? this.concepts.filter(c => c.tag === tag) : this.concepts;
                if (candidates.length) {
                    const picked = candidates[Math.floor(Math.random() * candidates.length)];
                    this.send(this.flattenConcept(picked));
                } else {
                    this.send(`No ${tag || ""} concepts`);
                }
                break;
        }
    }
}, "semantic picker with reference resolution");