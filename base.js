export const programs = new Map();
export function registerProgram(name, handlers, description) {
    const handlerText = {};
    for (const [name, f] of Object.entries(handlers)) handlerText[name] = f.toString();
    programs.set(name, {
        name,
        PID: 1,
        handlers: handlerText,
        description: description || "No description",
    });
}
export function cp(name, handlers, description) {
    registerProgram(name, handlers, `${description} [claude-program]`)
}