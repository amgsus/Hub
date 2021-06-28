/*
 * By:       A.G.
 * Modified: 2019.11.01
 */

// -----------------------------------------------------------------------------

import Colors from "colors/safe.js";
import args   from "./args.mjs";

const ENTRY_LEVELS = [ "silly", "trace", "debug", "info", "warn", "error", "alert", "fatal" ];
const MAX_ENTRY_LEVEL_LENGTH = (() => ENTRY_LEVELS.reduce((prev, that) => Math.max(prev, that.length), 0))();

// ------------------------------------------------- JSDoc for Logger object ---

/**
 * @class
 * @name Logger
 */

/**
 * @method
 * @name Logger#silly
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#trace
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#debug
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#info
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#warn
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#error
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#alert
 * @param {?} message
 * @param {...?} moreMessages
 */

/**
 * @method
 * @name Logger#fatal
 * @param {?} message
 * @param {...?} moreMessages
 */

// ----------------------------------------------------------------------------

/**
 * @param [label=""] {string}
 * @returns {Logger}
 */
export function
createLogger(label = "") {
    let wrapper = {};

    for ( let level of ENTRY_LEVELS ) {
        wrapper[level] = args.console ? wrapConsole(level, label) : dummy;
    }

    wrapper.plain = args.console ? wrapConsole("", label) : dummy;
    wrapper.color = args.console ? (c, ...s) => console.log(Colors[c](s.join(" "))) : dummy;
    wrapper.print = args.console ? console.log : dummy;
    return (wrapper);
}

/**
 *
 * @param {string} level
 * @param {string} label
 * @returns {Function}
 */
function
wrapConsole(level, label) {
    let fn = console.log;
    let levelColored = (level && String(level) !== "")
        ? `[${Colors[mapLevelColor(level)](level.padStart(MAX_ENTRY_LEVEL_LENGTH))}]`
        : "";
    if (label && label !== "") {
        if (levelColored !== "") {
            return function (...content) {
                fn(`${now()} ${levelColored} ${label}:`, ...content);
            };
        } else {
            return function (...content) {
                fn(`${now()} ${label}:`, ...content);
            };
        }
    } else {
        if (levelColored !== "") {
            return function (...content) {
                fn(`${now()} ${levelColored}`, ...content);
            };
        } else {
            return function (...content) {
                fn(now(), ...content);
            };
        }
    }
}

function
dummy()
{
    // Nothing.
}

function now() {
    return new Date().toISOString();
}

function
mapLevelColor(level)
{
    const DEFINED_COLORS = {
        debug: "cyan",
        info: "green",
        warn: "yellow",
        warning: "yellow",
        error: "red",
        fatal: "america"
    };
    let color = DEFINED_COLORS[level];
    return color || "reset";
}
