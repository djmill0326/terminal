import { isNumericAscii } from "../helpers.js";

export const tagWhitelist = new Set([
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    /* "audio", */
    "b",
    /* "base", */
    "bdi",
    "bdo",
    "blockquote",
    /* "body", */
    "br",
    "button",
    /* "canvas", */ 
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    /* "datalist", */ 
    "dd",
    "del",
    "details",
    "dfn",
    /* "dialog", */ 
    "div",
    "dl",
    "dt",
    "em",
    /* "embed", */
    /* "fieldset", */
    "figcaption",
    "figure",
    "footer",
    /* "form", */
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    /* "head", */
    "header",
    "hgroup",
    "hr",
    /* "html", */
    "i",
    /* "iframe", */
    "img",
    /* "input", */
    "ins",
    "kbd",
    /* "label", */
    "legend",
    "li",
    /* "link", */
    "main",
    "map",
    "mark",
    "menu",
    /* "meta", */
    "meter",
    "nav",
    /* "noscript", */
    /* "object", */
    "ol",
    /* "optgroup", */
    /* "option", */
    "p",
    /* "param", */
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    /* "script", */
    "search",
    "section",
    /* "select", */
    "small",
    /* "source", */
    "span",
    "strong",
    /* "style", */
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    /* "template", */
    /* "textarea" */
    "tfoot",
    "th",
    "thead",
    "time",
    /* "title", */
    "tr",
    /* "track", */
    "u",
    "ul",
    "var",
    /* "video", */
    "wbr"
]);

export const attributeWhitelist = new Set([
    /* "accept", */
    /* "accept-charset", */
    /* "accesskey", */
    /* "action", */
    "alt",
    /* "async", */
    /* "autocomplete", */
    /* "autofocus", */
    /* "autoplay", */
    /* "charset", */
    /* "checked", */
    "cite",
    /* "class", special case */
    /* "cols", */
    "colspan",
    /* "content", */
    /* "contenteditable", */
    /* "controls", */
    "coords",
    /* "data", */
    /* "data-*", special case */
    "datetime",
    /* "default", */
    /* "defer", */
    "dir",
    /* "dirname", */
    /* "disabled", */
    /* "download", */
    "draggable",
    /* "enctype", */
    /* "enterkeyhint", */
    /* "for", */
    /* "form", */
    /* "formaction", */
    "headers",
    "height",
    "hidden",
    "high",
    /* "href", special case */
    /* "hreflang", */
    /* "http-equiv", */
    /* "id", */
    "inert",
    /* "inputmode", */
    "ismap",
    /* "kind", */
    /* "lang", */
    /* "list", */
    /* "loop", */
    "low",
    "max",
    /* "maxlength", */
    /* "media", */
    /* "method", */
    "min",
    /* "multiple", */
    /* "muted", */
    "name",
    /* "novalidate", */
    /* "on-*", special case */
    "open",
    "optimum",
    /* "pattern", */
    /* "placeholder", */
    "popover",
    "popovertarget",
    "popovertargetaction",
    /* "poster", */
    /* "preload", */
    /* "readonly", */
    /* "rel", */
    /* "required", */
    "reversed",
    /* "rows", */
    "rowspan",
    /* "sandbox", */
    "scope",
    /* "selected", */
    "shape",
    "sizes",
    "span",
    /* "spellcheck", */
    /* "src", special case */
    /* "srcdoc", */
    /* "srclang", */
    /* "srcset", */
    "start",
    /* "step", */
    /* "style", special case */
    "tabindex",
    /* "target", */
    "title",
    "translate",
    "type",
    "usemap",
    "value",
    "width",
    /* "wrap" */
]);

export const eventWhitelist = new Set([
    /* many (likely safe) events missing */
    /* window events omitted */
    "blur",
    "change",
    /* "contextmenu", */
    "focus",
    "input",
    "invalid",
    "reset",
    "search",
    "select",
    "submit",
    "keydown",
    "keypress",
    "keyup",
    "click",
    "dblclick",
    "mousedown",
    "mousemove",
    "mouseout",
    "mouseover",
    "mouseup",
    "mousewheel",
    "wheel",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "dragstart",
    "drop",
    "scroll",
    /* "copy", */
    /* "cut", */
    /* "paste", */
    /* media events omitted */
    "ontoggle",
    "touchstart",
    "touchend",
    "touchmove",
    "touchcancel",
    /* "gotpointercapture", */
    /* "lostpointercapture", */
    "pointercancel",
    "pointerdown",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "pointerout",
    "pointerover",
    /* "pointerrawupdate", */
    "pointerup"
]);

/* Simple style definition sanitizer */

function tokenize(description) {
    const tokenList = [];
    let temp = "";
    let withinComment = false;
    let quoting = false;
    let quotingSingle = false;
    let maybeLink = false;

    const flush = (as="identOrValue") => {
        if (temp) {
            tokenList.push([maybeLink ? "maybeLink" : as, temp]);
            temp = "";
            maybeLink = false;
        }
    };

    for (let i = 0; i < description.length; i++) {
        const c = description[i];
        if (withinComment) {
            if (c === "/" && description[i - 1] === "*") withinComment = false;
            continue;
        }
        switch (c) {
            case '"':
                if (quotingSingle) {
                    temp += '"';
                    continue;
                }
                if (quoting) {
                    flush("valueString");
                    quoting = false;
                    continue;
                }
                quoting = true;
                continue;
            case "'":
                if (quoting) {
                    temp += "'";
                    continue;
                }
                if (quotingSingle) {
                    flush("valueString");
                    quotingSingle = false;
                    continue;
                }
                quotingSingle = true;
                continue;
            case ".":
                if (!isNumericAscii(description[i + 1])) maybeLink = true;
                break;
            case "/":
                if (!(quoting || quotingSingle) && description[i + 1] === "*") {
                    flush();
                    withinComment = true;
                    continue;
                }
                // beautiful intentional fallthrough
            case ":":
                maybeLink = true;
                break;
        }
        if (quotingSingle || quoting) {
            temp += c;
            continue;
        }
        switch (c) {
            case "(":
                flush();
                tokenList.push(["open_paren", "("]);
                break;
            case ")":
                flush();
                tokenList.push(["close_paren", ")"]);
                break;
            case ",":
            case " ":
                flush();
                break;
            default:
                temp += c;
        }
    }

    if (temp) tokenList.push(["identOrValue", temp]);
    return tokenList;
}

const blacklistedIdentifiers = new Set([
    "var",
    "url",
    "attr",
    "image",
    "image-set",
    "paint",
    "symbols"
]);

export function styleSanitizer(_property, description) {
    for (const [type, value] of tokenize(description)) {
        if (type === "maybeLink" || 
            (type === "identOrValue" && blacklistedIdentifiers.has(value))) {
            return false;
        }
    }
    return true;
}

export function createSanitizedStyle(text) {
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(text);
    const rules = stylesheet.cssRules;
    for (let i = 0; i < rules.length; i++) {
        const rule = rules.item(i);
        const style = rule.style;
        let text = `${rule.selectorText} {\n`;
        let modified = false;
        for (const property of style) {
            const description = style[property];
            if (styleSanitizer(property, description)) text += `\t${property}: ${description};\n`;
            else modified = true;
        }
        if (modified) {
            stylesheet.deleteRule(i);
            stylesheet.insertRule(text, i);
        }
    }
    return stylesheet;
}