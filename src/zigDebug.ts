"use strict";

// import * as vscode from "vscode";
import { DebugProtocol } from "vscode-debugprotocol";
import {
    DebugSession,
    LoggingDebugSession,
    Logger,
    logger,
    InitializedEvent,
    StoppedEvent,
    Thread,
    StackFrame,
    Source,
    Handles,
    Scope,
    Variable,
    TerminatedEvent,
    OutputEvent,
} from "vscode-debugadapter";
import * as cp from "child_process";
import * as path from "path";

// export class ZigDebugConfigurationProvider
//     implements vscode.DebugConfigurationProvider {
//     /**
//      * Massage a debug configuration just before a debug session is being launched,
//      * e.g. add all missing attributes to the debug configuration.
//      */
//     resolveDebugConfiguration(
//         folder: vscode.WorkspaceFolder | undefined,
//         config: vscode.DebugConfiguration,
//         token?: vscode.CancellationToken,
//     ): vscode.ProviderResult<vscode.DebugConfiguration> {
//         // TODO: implement
//         return config;
//     }
// }

namespace MIOutputParser {
    // Reference syntax:
    // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html#GDB_002fMI-Output-Syntax

    // const ->
    //      c-string
    function parseConst(miOutput: string, startAt: number): [number, string] {
        let i = startAt;
        if (miOutput[i] == "{") {
            i++;
            let closingBraceStack = 1;
            while (closingBraceStack > 0) {
                if (miOutput[i] == "}") {
                    closingBraceStack--;
                } else if (miOutput[i] == "{") {
                    closingBraceStack++;
                }
                i++;
            }
        } else {
            let prev = i;
            // Example: ~"([]u8) $0 = (ptr = \"something\", len = 9)\n"
            while (miOutput[i] != '"' || miOutput[prev] == "\\") prev = i++;
        }
        return [i, miOutput.slice(startAt, i)];
    }

    // list ->
    //      "[]" | "[" value ( "," value )* "]" | "[" result ( "," result )* "]"
    function parseList(
        miOutput: string,
        startAt: number,
    ): [number, Array<any>] {
        let results: any[] = [];
        let i = startAt;
        while (miOutput[i] != "]") {
            if (miOutput[i].match(/[0-9a-zA-Z]/)) {
                const [endedAt, result] = parseResult(miOutput, i);
                results.push(result);
                i = endedAt;
            } else {
                const [endedAt, result] = parseValue(miOutput, i);
                results.push(result);
                i = endedAt;
            }

            if (miOutput[i] == ",") {
                i++;
            } else if (miOutput[i] == "]") {
                continue;
            } else {
                throw new Error(
                    "Unknown position after parsing result inside list",
                );
            }
        }

        return [i, results];
    }

    function listToObj(list: Array<{ [key: string]: any }>) {
        return list.reduce((acc, res) => {
            const key = Object.keys(res)[0];
            if (acc[key]) {
                if (Array.isArray(acc[key])) {
                    acc[key].push(res[key]);
                } else {
                    // We've got duplicate keys in this object, therefore
                    // lets turn this field (specified by key) into an array
                    // NOTE: this usually happens with "frame" fields in the
                    // thread info output
                    acc[key] = [acc[key], res[key]];
                }
            } else {
                acc[key] = res[key];
            }

            return acc;
        }, {});
    }

    // tuple ->
    //      "{}" | "{" result ( "," result )* "}"
    function parseTuple(miOutput: string, startAt: number): [number, any] {
        let results = [];
        let i = startAt;
        while (miOutput[i] != "}") {
            const [endedAt, result] = parseResult(miOutput, i);
            results.push(result);
            i = endedAt;

            if (miOutput[i] == ",") {
                i++;
            } else if (miOutput[i] == "}") {
                continue;
            } else {
                throw new Error(
                    "Unknown position after parsing result inside tuple",
                );
            }
        }

        const result = listToObj(results);
        return [i, result];
    }

    // value ->
    //      const | tuple | list
    function parseValue(miOutput: string, startAt: number): [number, any] {
        let endedAt;
        let value;

        const first = miOutput[startAt];
        if (first == '"') {
            let result = parseConst(miOutput, startAt + 1);
            endedAt = result[0];
            value = result[1];

            // Example output: ^done,threads="[]"
            // Which occurs when calling -thread-info with nothing running
            if (value == "[]") {
                value = [];
            }
        } else if (first == "{") {
            let result = parseTuple(miOutput, startAt + 1);
            endedAt = result[0];
            value = result[1];
        } else if (first == "[") {
            let result = parseList(miOutput, startAt + 1);
            endedAt = result[0];
            value = result[1];
        } else {
            throw new Error(
                `Failed to parse value, unknown first character ${first}`,
            );
        }

        // +1 to pass over the last matching '"' | '}' | ']'
        return [endedAt + 1, value];
    }

    // result ->
    //      variable "=" value
    function parseResult(miOutput: string, startAt: number): [number, any] {
        let i = miOutput.indexOf("=", startAt);
        const variableName = miOutput.slice(startAt, i);
        const [endedAt, value] = parseValue(miOutput, i + 1);

        return [endedAt, { [variableName]: value }];
    }

    // There's commonality between a result-record's body and async-output
    // -> class ( "," result )*
    function parseClassOutput(
        miOutput: string,
        startAt: number,
        checkWithClassSet?: Set<string> | undefined,
    ) {
        let endOfClass = miOutput.indexOf(",", startAt);
        if (endOfClass == -1) {
            // Example output that triggers this: 1^done
            endOfClass = miOutput.length;
        }

        const _class = miOutput.slice(startAt, endOfClass);
        if (checkWithClassSet && !checkWithClassSet.has(_class)) {
            throw new Error(
                `Class <${_class}> does not belong in class set ${JSON.stringify(
                    checkWithClassSet,
                )}`,
            );
        }

        let i = endOfClass;
        let results: any[] = [];
        while (i < miOutput.length) {
            if (miOutput[i] != ",") {
                throw new Error("Failed while parsing results");
            }

            const [endedAt, result] = parseResult(miOutput, i + 1);
            results.push(result);
            i = endedAt;
        }

        const output = listToObj(results);
        return {
            class: _class,
            output,
        };
    }

    // async-output ->
    //      async-class ( "," result )*
    // NOTE: no class is provided to parseClassOutput since the docs don't
    // show all that are possible for async-output. This means allow any
    // keyword in the "async-class" part.
    function parseAsyncOutput(miOutput: string, startAt: number) {
        return parseClassOutput(miOutput, startAt);
    }

    const knownResultClasses = new Set([
        "done",
        "running",
        "connected",
        "error",
        "exit",
    ]);

    // result-output ->
    //      result-class ( "," result )*
    function parseResultOutput(miOutput: string, startAt: number) {
        return parseClassOutput(miOutput, startAt, knownResultClasses);
    }

    export type StreamOutput = {
        kind:
            | "console-stream-output"
            | "target-stream-output"
            | "log-stream-output";
        output: string;
    };

    export type RecordOutput = {
        kind:
            | "exec-async-output"
            | "status-async-output"
            | "notify-async-output"
            | "result-record";
        token: number | null;
        class: string;
        output: {
            [key: string]: any;
        };
    };

    // record ->
    //      out-of-bad-record | result-record
    //
    // out-of-band-record ->
    //      async-record | stream-record
    //
    // async-record ->
    //      exec-async-output | status-async-output | notify-async-output
    //
    // exec-async-output ->
    //      [ token ] "*" async-output nl
    //
    // status-async-output ->
    //      [ token ] "+" async-output nl
    //
    // notify-async-output ->
    //      [ token ] "=" async-output nl
    //
    // result-record ->
    //      [ token ] "^" result-class ( "," result )* nl
    export function parseRecord(miOutput: string): StreamOutput | RecordOutput {
        let i = 0;
        while (miOutput[i].match(/[0-9]/)) i++;
        const token = i > 0 ? parseInt(miOutput.slice(0, i)) : null;
        switch (miOutput[i]) {
            case "~": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { kind: "console-stream-output", output };
            }
            case "@": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { kind: "target-stream-output", output };
            }
            case "&": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { kind: "log-stream-output", output };
            }
            case "*": {
                return {
                    kind: "exec-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "+": {
                return {
                    kind: "status-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "=": {
                return {
                    kind: "notify-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "^": {
                return {
                    kind: "result-record",
                    token,
                    ...parseResultOutput(miOutput, i + 1),
                };
            }
            default: {
                throw new Error("Unknown record type");
            }
        }
    }
}

namespace MIOutputVariableParser {
    export type MIVariableOutput =
        | null
        | {
              kind: "struct";
              data: { [key: string]: MIVariableOutput };
          }
        | { kind: "array"; data: MIVariableOutput[] }
        | { kind: "slice-data"; data: string }
        | { kind: "pointer"; data: string }
        | { kind: "char"; data: number }
        | { kind: "int"; data: number }
        | { kind: "float"; data: number };

    // Examples:
    // u8:                             "98 'b'"
    // i32:                            "32"
    // Array of i32|u32:               "{[0] = 1, [1] = 2}"
    // Array of u8:                    "{[0] = 104 'h', [1] = 101 'e', [2] = 108 'l', [3] = 108 'l', [4] = 111 'o'}"
    // Pointer:                        "{tag = (none), value = 0x0000000100200080}"
    //                                 "0x0000000100031dd0"
    // Slice:                          "{ptr = 0x0000000100031de0 \"Hello\", len = 5}"
    // Struct {name: []u8, age: i32}:  "{name = {ptr = 0x0000000100032dc0 \"Bob\", len = 3}, age = 33}"
    // Struct {name: [3]u8, age: i32}: "{name = {[0] = 66 'B', [1] = 111 'o', [2] = 98 'b'}, age = 33}"
    function parseOutput(
        output: string,
        startAt: number,
    ): [number, MIVariableOutput] {
        if (output[startAt] == "{" && output[startAt + 1] == "[") {
            let i = startAt;
            let results: MIVariableOutput[] = [];
            while (output[i] != "}") {
                let startOfValue = output.indexOf("=", i);
                if (startOfValue == -1) {
                    throw new Error(
                        "Failed to parse array from variable output",
                    );
                }
                // Value looks like this: "= <val-here>", so lets skip over = and space
                startOfValue += 2;

                const [endedAt, result] = parseOutput(output, startOfValue);
                i = endedAt;

                if (output[i] == ",") {
                    i += 2; // +2 to skip over ", "
                } else if (output[i] != "}") {
                    throw new Error(
                        "Invalid state while parsing array. Expected comma or closing bracket.",
                    );
                }

                results.push(result);
            }
            i++; // Skip over last '}'

            return [i, { kind: "array", data: results }];
        } else if (output[startAt] == "{") {
            let data: { [key: string]: MIVariableOutput } = {};

            let i = startAt + 1;
            while (output[i] != "}") {
                const endOfVarName = output.indexOf(" = ", i);
                if (endOfVarName == -1)
                    throw new Error("Unrecognized object type");
                const varName = output.slice(i, endOfVarName);

                i = endOfVarName + 3; // +3 to Skip over " = "
                const [endedAt, val] = parseOutput(output, i);
                i = endedAt;
                data[varName] = val;

                if (output[i] == ",") {
                    i += 2; // +2 to skip over ", "
                } else if (output[i] != "}") {
                    throw new Error(
                        "Invalid state while parsing object. Expected comma or closing bracket.",
                    );
                }
            }
            i++; // Skip over last '}'

            if (
                data.ptr != undefined &&
                data.ptr.kind == "slice-data" &&
                data.len != undefined &&
                data.len.kind == "int" &&
                Object.keys(data).length == 2
            ) {
                // lldb seems to be searching for \0 when it prints the data of a slice,
                // and thus sometimes merges contiguous segments of memory, which don't belong
                // together for the specified variable. Since we know what the length really
                // is at this point (data.len), lets slice what we need.

                const len = data.len.data;
                data.ptr.data = data.ptr.data.slice(0, len);
            }

            return [i, { kind: "struct", data }];
        } else if (output.startsWith("0x", startAt)) {
            // Pointer type or slice. Slice has string representation after address.
            const rest = output.slice(startAt + 2).match(/^([0-9a-f]+)/);
            if (!rest) throw new Error("Unrecognized pointer/slice output");

            const addr = "0x" + rest[1];
            let i = startAt + addr.length;
            if (output.startsWith(' \\"', i)) {
                const startOfData = i + 3; // +3 to skip the space, backslash, and beginning quote
                const endOfData = output.indexOf('\\"', startOfData);
                return [
                    endOfData + 2,
                    {
                        // We need to tell the caller that this is the slice-data segment
                        // of a slice. The caller will use this and the length attribute
                        // to construct a proper slice object. Check the comments of the
                        // caller for the reasoning.
                        kind: "slice-data",
                        data: output.slice(startOfData, endOfData),
                    },
                ];
            } else {
                return [i, { kind: "pointer", data: addr }];
            }
        } else if (output.startsWith('\\"', startAt)) {
            const startOfData = startAt + 2; // +2 to skip the backslash, and beginning quote
            const endOfData = output.indexOf('\\"', startOfData);
            return [
                endOfData + 2,
                {
                    // We need to tell the caller that this is the slice-data segment
                    // of a slice. The caller will use this and the length attribute
                    // to construct a proper slice object. Check the comments of the
                    // caller for the reasoning.
                    kind: "slice-data",
                    data: output.slice(startOfData, endOfData),
                },
            ];
        } else if (output[startAt].match(/[0-9]/)) {
            // Number or char
            const numMatch = output.slice(startAt).match(/^(\d+)/);
            if (!numMatch) throw new Error("Unrecognized number or char");
            const num = numMatch[1];

            let i = startAt + num.length;
            if (output.startsWith(" '", i)) {
                // This is a char
                const startOfChar = startAt + num.length + 2;
                const endOfChar = output.indexOf("'", startOfChar);

                // TODO: not returning the character due to not knowing exactly
                // how to represent it in the VSCode UI. If returned like it is
                // currently, it looks like a string ("a" for example). So when
                // a user goes to edit it, should they for example type in "b"?
                // No, "b" is not allowed by lldb/gdb. It has to be 'b' or 98
                // which is not clear from the "a". Therefore lets return the
                // ascii number which is at least clear on how to modify.
                // return [endOfChar + 1, output.slice(startOfChar, endOfChar)];

                return [endOfChar + 1, { kind: "char", data: parseInt(num) }];
            } else if (output.startsWith(".", i)) {
                i++; // Skip over the dot
                const decimalMatch = output.slice(i).match(/^(\d+)/);
                if (!decimalMatch)
                    throw new Error("Invalid state when parsing float");
                const decimal = decimalMatch[1];
                return [
                    i + decimal.length,
                    { kind: "float", data: parseFloat(num + "." + decimal) },
                ];
            } else {
                return [i, { kind: "int", data: parseInt(num) }];
            }
        } else if (output.startsWith("(none)", startAt)) {
            return [startAt + "(none)".length, null];
        } else if (output.startsWith("<no value available>", startAt)) {
            return [startAt + "<no value available>".length, null];
        } else if (output.startsWith("??", startAt)) {
            return [startAt + "??".length, null];
        } else {
            throw new Error("Unrecognized output");
        }
    }

    export function parse(output: string) {
        const [_, result] = parseOutput(output, 0);
        return result;
    }
}

interface ThreadInfo {
    id: number;
    name: string;
    frames: StackFrameInfo[];
    state: string;
}

interface StackFrameInfo {
    threadId: number;
    level: number;
    address: string;
    function: string;
    file: string;
    filePath: string;
    line: number;
}

interface StackVariable {
    name: string;
    type: string;
    // If this is undefined it means it has not been evaluated. This allows us to
    // lazily evaluate a composite variable only when the user actually wants
    // to see its insides.
    value: undefined | MIOutputVariableParser.MIVariableOutput;
}

// This is what talks to gdb/lldb
class DebuggerInterface {
    private debuggerStartupCommand: string[];
    private debugProcess: cp.ChildProcess;

    // Whenever we write a command to be ran by the debuggers,
    // if we are expecting output, then we must register a callback
    // with the token (as the key) used in the input command.
    private callbackTable: Map<number, (data: any) => void>;

    // Set a callback to be notified when a stop even occurs in gdb/lldb
    public stopEventNotifier: (record: MIOutputParser.RecordOutput) => void;
    // Set a callback to be notified when an output event occurs in gdb/lldb
    public outputEventNotifier: (record: MIOutputParser.StreamOutput) => void;

    // The following are the expected sequence of stdout
    // messages from the corresponding debuggers when
    // starting them and no abnormal behavior.
    // NOTE: ignoring parts of the output, only really interested
    // in the beginning of the lines.
    // TODO: This probably only applies to my machine. Test with other machines.
    // *************************************************************
    private debuggerUsed: "lldb" | "gdb";
    private lldbStartupSequence = [
        "(gdb)",
        "-file-exec-and-symbols",
        "^done",
        "(gdb)",
        "=library-loaded",
    ];
    private gdbStartupSequence = [
        "=thread-group-added",
        '~"Reading symbols from main..."',
        '~"done.\n"',
        "(gdb)",
    ];
    // *************************************************************

    // Will be used as a token in the mi commands in order
    // to tie output with input.
    private tokenCount: number;

    constructor(pathToDebugger: string, pathToExectuable: string) {
        logw("DebuggerInterface:constructor");

        this.tokenCount = 0;
        this.callbackTable = new Map();
        this.stopEventNotifier = undefined;
        this.outputEventNotifier = undefined;

        // NOTE: gdb requires code signing on macOS. The following was
        // written for lldb, but apparently works for gdb too.
        // https://opensource.apple.com/source/lldb/lldb-69/docs/code-signing.txt

        this.debuggerUsed =
            pathToDebugger.indexOf("lldb-mi") != -1 ? "lldb" : "gdb";
        this.debuggerStartupCommand = [
            pathToDebugger,
            "-q",
            "--interpreter=mi2",
        ];
        this.debuggerStartupCommand.push(pathToExectuable);
    }

    public async launch(cwd: string, userArgs: string[]) {
        // Start up the debugger
        logw("DebuggerInterface:launch");

        let args = this.debuggerStartupCommand.slice(1);
        args.push(...userArgs);

        this.debugProcess = cp.spawn(this.debuggerStartupCommand[0], args, {
            cwd,
            env: {
                ...process.env,
                // TODO: do this properly
                // LLDB requires macOS's python, therefore we must
                // make sure it's selected over brew's.
                ...(this.debuggerUsed == "lldb"
                    ? { PATH: "/usr/bin:" + process.env.PATH }
                    : {}),
            },
        });

        // Setting up handlers for initialization of debugger
        try {
            await new Promise((res, rej) => {
                this.debugProcess.on("error", err => {
                    return rej(err);
                });

                this.debugProcess.stderr.on("data", data => {
                    // TODO: what to do in this case?
                    loge(`stderr output: ${data}`);
                });

                let startupSequence =
                    this.debuggerUsed == "lldb"
                        ? this.lldbStartupSequence.slice()
                        : this.gdbStartupSequence.slice();

                this.debugProcess.stdout.on("data", data => {
                    const gotLines = data
                        .toString()
                        .trim()
                        .split("\n");
                    for (const line of gotLines) {
                        // TODO: this might not be an issue
                        if (startupSequence.length <= 0) {
                            return rej(
                                `Initialization triggered more lines than expected`,
                            );
                        }

                        const expectedStart = startupSequence.shift();
                        if (!line.startsWith(expectedStart)) {
                            return rej(
                                `Expected line start: ${expectedStart}, but instead got: ${line}`,
                            );
                        }
                    }

                    // TODO: this might be an issue if more lines
                    // are returned than expected.
                    if (startupSequence.length == 0) {
                        return res();
                    }
                });
            });
        } catch (err) {
            loge(`Failed to launch debugger: ${err}`);
            this.kill();
            throw err;
        }

        // We're done with the initialization phase, lets
        // clear the init event handlers and set the regular
        // handlers.

        this.debugProcess.removeAllListeners();
        this.debugProcess.on("error", err => {
            loge(`Got an error: ${err}`);
            // TODO: only kill when necessary
            this.kill();
        });

        this.debugProcess.stdout.removeAllListeners();
        this.debugProcess.stdout.on("data", data => {
            const strData = data.toString().trim();

            for (const line of strData.split("\n")) {
                if (line == "(gdb)") continue;

                let record;
                try {
                    record = MIOutputParser.parseRecord(line);
                } catch (err) {
                    // lldb outputs stuff like "1 location added to breakpoint 1"
                    loge(`Failed to parse output: ${line}`);
                    continue;
                }

                if (record.kind == "result-record" && record.token != null) {
                    const callback = this.callbackTable.get(record.token);
                    if (callback) {
                        callback(record);
                    } else {
                        loge(
                            `Have data for mi command with token but no callback is registered: '${
                                record.token
                            }'`,
                        );
                    }
                } else if (
                    record.kind == "exec-async-output" &&
                    record.class == "stopped" &&
                    this.stopEventNotifier
                ) {
                    this.stopEventNotifier(record);
                } else if (
                    (record.kind == "console-stream-output" ||
                        record.kind == "log-stream-output" ||
                        record.kind == "target-stream-output") &&
                    record.output != undefined &&
                    this.outputEventNotifier
                ) {
                    this.outputEventNotifier(record);
                } else {
                    logw(`miOutput: ${JSON.stringify(record)}`);
                }
            }
        });

        this.debugProcess.stderr.removeAllListeners();
        this.debugProcess.stderr.on("data", data => {
            loge(`debugProcess stderr: ${data}`);
        });
    }

    public run() {
        logw("DebuggerInterface:run");

        const token = this.tokenCount++;
        const miCommand = `${token}-exec-run\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for run with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(`Failed to run program: ${result.output.msg}`);
                } else {
                    return rej(
                        `Unexpected output for run with token ${token}: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public kill() {
        // Terminate the program
        logw("DebuggerInterface:kill");
        // TODO: try quitting in (gdb/mi)/(lldb-mi) first
        this.debugProcess.kill();
    }

    public insertBreakpoint(
        shortFileName: string,
        lineNumber: number,
    ): Promise<[number, number]> {
        logw("DebuggerInterface:insertBreakpoint");

        const token = this.tokenCount++;
        const miCommand = `${token}-break-insert ${shortFileName}:${lineNumber}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(
                    `Received output for insertBreakpoint with token ${token}`,
                );
                this.callbackTable.delete(token);

                if (result.class == "done" && result.output.bkpt) {
                    // Example outputs:
                    // lldb:
                    // bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00000001000235a8",func="main",file="main",fullname="src/main",line="7",times="0",original-location="main.zig:5"}
                    // gdb:
                    // bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00000001000235af",func="main",file="/Users/hchac/prj/playground/zig/test/src/main.zig",fullname="/Users/hchac/prj/playground/zig/test/src/main.zig",line="8",thread-groups=["i1"],times="0",original-location="main.zig:8"}
                    const bkpt = result.output.bkpt;

                    // This needs to be used as the identifier when deleting
                    // the breakpoint.
                    const breakpointId = bkpt.number;
                    if (!breakpointId) {
                        return rej(
                            `Failed to get breakpoint number: ${bkpt.number}`,
                        );
                    }

                    // If a user specifies a breakpoint at say line 5, and there'strrecord no
                    // code at that line, lldb or gdb will let you know where it
                    // actually found a spot to place the breakpoint further down.
                    const actualBreakpointLine = bkpt.line;
                    if (!actualBreakpointLine) {
                        return rej(
                            `Failed to get breakpoint line from output: ${
                                bkpt.line
                            }`,
                        );
                    }

                    return res([
                        parseInt(breakpointId),
                        parseInt(actualBreakpointLine),
                    ]);
                } else if (result.class == "error" && result.output.msg) {
                    // Example output:
                    // '1^error,msg="No line 88 in file "main.zig"."'
                    return rej(
                        `Error for insertBreakpoint with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output for insertBreakpoint with token ${token}: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public deleteBreakpoint(breakpointId: number): Promise<number> {
        logw("DebuggerInterface:deleteBreakpoint");

        const token = this.tokenCount++;
        const miCommand = `${token}-break-delete ${breakpointId}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(
                    `Received output for deleteBreakpoint with token ${token}`,
                );
                this.callbackTable.delete(token);

                if (result.class == "done") {
                    // Example output:
                    // 1^done
                    return res(breakpointId);
                } else if (result.class == "error" && result.output.msg) {
                    // Example:
                    // 12^error,msg="Command 'break-delete'. Breakpoint '4' invalid"
                    return rej(
                        `Error for deleteBreakpoint with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output for deleteBreakpoint with token ${token}: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public threadInfo(): Promise<Array<ThreadInfo>> {
        logw("DebuggerInterface:threadInfo");

        const token = this.tokenCount++;
        const miCommand = `${token}-thread-info\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for threadInfo with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "done" && result.output.threads) {
                    const threadInfoList = new Array<ThreadInfo>();
                    for (const threadInfo of result.output.threads) {
                        const id = parseInt(threadInfo.id);
                        if (isNaN(id)) {
                            return rej(
                                `Failed to parse thread id: ${threadInfo.id}`,
                            );
                        }
                        const name = threadInfo["target-id"];
                        const state = threadInfo.state;
                        const frames = Array.isArray(threadInfo.frame)
                            ? this.parseStackFrames(id, threadInfo.frame)
                            : this.parseStackFrames(id, [threadInfo.frame]);

                        threadInfoList.push({ id, name, frames, state });
                    }

                    return res(threadInfoList);
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for threadInfo with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from threadInfo: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    private parseStackFrames(threadId: number, frames: any[]) {
        let results = new Array<StackFrameInfo>();

        for (const f of frames) {
            // Example output that we should avoid processing:
            // {
            //     "level": "4",
            //     "addr": "0x00007fff652773d5",
            //     "func": "start",
            //     "file": "??",
            //     "fullname": "??",
            //     "line": "-1"
            // }
            if (f.line == "-1" || f.file == "??" || f.fullname == "??")
                continue;

            const level = parseInt(f.level);
            if (isNaN(level)) {
                loge(`Failed to parse frame level from "${f.level}"`);
                continue;
            }

            const line = parseInt(f.line);
            if (isNaN(line)) {
                loge(`Failed to parse frame line from "${f.line}"`);
                continue;
            }

            results.push({
                threadId,
                level,
                address: f.addr,
                function: f.func,
                file: f.file,
                filePath: f.fullname,
                line,
            });
        }

        return results;
    }

    public stackListVariables(
        threadId: number,
        frameLevel: number,
    ): Promise<StackVariable[]> {
        logw("DebuggerInterface:stackListVariables");

        const token = this.tokenCount++;
        // NOTE: using --simple-values to get the types of the variables. This will not
        // output the values of composite types, such as arrays and structs. When the user
        // requests to see the insides of these composite types, they will need to be
        // retrieved with dataEval.
        // TODO: this gives both local and arguments, maybe seperate them in the future?
        const miCommand = `${token}-stack-list-variables --thread ${threadId} --frame ${frameLevel} --simple-values\n`;

        return new Promise((res, rej) => {
            const receive = async (result: MIOutputParser.RecordOutput) => {
                logw(
                    `Received output for stackListVariables with token ${token}`,
                );
                this.callbackTable.delete(token);

                if (result.class == "done" && result.output.variables) {
                    let results = new Array<StackVariable>();
                    for (const v of result.output.variables) {
                        // If it's a composite type, v.value should be undefined since we
                        // used --simple-values in the -stack-list-variables command. In this
                        // case we do not evaluate the expression to retrieve its value to avoid
                        // doing extra work. Only when the user in the UI clicks on the composite
                        // type to inspect its insides should it be evaluated.
                        //
                        // Set value to null to tell the UI handler code that this is a composite
                        // type and it should evaluate when it needs to see the value.
                        const value =
                            v.value && MIOutputVariableParser.parse(v.value);
                        results.push({
                            name: v.name,
                            type: v.type,
                            value: value,
                        });
                    }

                    return res(results);
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for stackListVariables with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from stackListVariables: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public continue(): Promise<{}> {
        logw("DebuggerInterface:continue");

        const token = this.tokenCount++;
        // TODO: using --all for now, but should probably use --thread-group
        const miCommand = `${token}-exec-continue --all\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for continue with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for continue with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from continue: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public next(threadId: number): Promise<{}> {
        logw("DebuggerInterface:next");

        const token = this.tokenCount++;
        const miCommand = `${token}-exec-next --thread ${threadId}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for next with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for next with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from next: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public step(threadId: number): Promise<{}> {
        logw("DebuggerInterface:step");

        const token = this.tokenCount++;
        const miCommand = `${token}-exec-step --thread ${threadId}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for step with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for step with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from step: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public finish(threadId: number): Promise<{}> {
        logw("DebuggerInterface:finish");

        const token = this.tokenCount++;
        const miCommand = `${token}-exec-finish --thread ${threadId}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for finish with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for finish with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from finish: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public interrupt(): Promise<{}> {
        logw("DebuggerInterface:interrupt");

        const token = this.tokenCount++;
        // TODO: using --all for now, but should probably use --thread-group
        const miCommand = `${token}-exec-interrupt --all\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for interrupt with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "running") {
                    return res();
                } else if (result.class == "error" && result.output.msg) {
                    return rej(
                        `Error for interrupt with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from interrupt: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public dataEval(
        expr: string,
    ): Promise<MIOutputVariableParser.MIVariableOutput> {
        logw("DebuggerInterface:dataEval");

        const token = this.tokenCount++;
        const miCommand = `${token}-data-evaluate-expression "${expr}"\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for dataEval with token ${token}`);
                this.callbackTable.delete(token);

                if (result.class == "done" && result.output.value) {
                    return res(
                        MIOutputVariableParser.parse(result.output.value),
                    );
                } else if (result.class == "error" && result.output.msg) {
                    return rej(result.output.msg);
                } else {
                    return rej(
                        `Unexpected output from dataEval: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public evaluate(expr: string): Promise<string> {
        logw("DebuggerInterface:evaluate");

        const token = this.tokenCount++;
        const trimmedExpr = expr.trim();

        let usingMi = false;
        let command;
        // No space allowed between token and expression when using mi commands
        if (trimmedExpr[0] == "-") {
            usingMi = true;
            command = `${token}${trimmedExpr}\n`;
        } else {
            command = `${token} ${trimmedExpr}\n`;
        }

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(`Received output for evaluate with token ${token}`);
                this.callbackTable.delete(token);

                if (usingMi && result.class == "done") {
                    return res(JSON.stringify(result.output));
                } else if (!usingMi && result.class == "done") {
                    return res("");
                } else if (result.class == "error" && result.output.msg) {
                    return rej(result.output.msg);
                } else {
                    return rej(
                        `Unexpected output from evaluate: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(command);
            logw(`Wrote ${command}`);
        });
    }
}

function log(msg: string) {
    logger.log(msg);
}

function logw(msg: string) {
    logger.warn(msg);
}

function loge(msg: string) {
    logger.error(msg);
}

interface LaunchSettings extends DebugProtocol.LaunchRequestArguments {
    pathToBinary: string;
    pathToDebugger: string;
    args: string[];
}

enum ErrorCodes {
    UnrecognizedDebugger,
    LaunchFailure,
}

// Handles debug events/requests coming from VSCode.
class ZigDebugSession extends LoggingDebugSession {
    private debgugerInterface: DebuggerInterface;
    // Map layout:
    // "filename": {
    //     lineNumber: <breakpointId>
    // }
    private breakpoints: Map<string, Map<number, number>>;
    private threadInfo: Map<number, ThreadInfo>;
    private stackFrameHandles: Handles<[number, number]>;
    private variableHandles: Handles<
        | { kind: "locals"; data: StackVariable[] }
        | {
              kind: "inner-value";
              fullVarPath: string;
              data: MIOutputVariableParser.MIVariableOutput;
          }
        | { kind: "pending-eval"; fullVarPath: string; type: string }
    >;

    public constructor(
        debuggerLinesStartAt1: boolean,
        isServer: boolean = false,
    ) {
        super("", debuggerLinesStartAt1, isServer);
        this.breakpoints = new Map();
        this.threadInfo = new Map();
        this.stackFrameHandles = new Handles();
        this.variableHandles = new Handles();
    }

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments,
    ) {
        logw("ZigDebugSession:initialize");

        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;

        this.sendResponse(response);
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchSettings,
    ) {
        logw("ZigDebugSession:launch");
        logger.setup(Logger.LogLevel.Verbose);

        if (
            // TODO: better way to verify that user is using an allowed debugger?
            args.pathToDebugger.indexOf("lldb-mi") == -1 &&
            args.pathToDebugger.indexOf("gdb") == -1
        ) {
            this.sendErrorResponse(
                response,
                ErrorCodes.UnrecognizedDebugger,
                "Could not recognize debugger in pathToDebugger. Please make sure you are using gdb or lldb-mi (not lldb).",
            );
            return;
        }

        this.debgugerInterface = new DebuggerInterface(
            args.pathToDebugger,
            args.pathToBinary,
        );

        this.debgugerInterface.stopEventNotifier = record => {
            logw(`Received stop event with: ${JSON.stringify(record)}`);
            // TODO: create type for this
            // Example record:
            // {
            //     "type": "exec-async-output",
            //     "token": null,
            //     "class": "stopped",
            //     "output": {
            //         "reason": "breakpoint-hit",
            //         "disp": "del",
            //         "bkptno": "1",
            //         "frame": {
            //             "level": "0",
            //             "addr": "0x0000000100023634",
            //             "func": "main",
            //             "args": [],
            //             "file": "main.zig",
            //             "fullname": "/Users/hchac/prj/playground/zig/test/src/main.zig",
            //             "line": "4"
            //         },
            //         "thread-id": "1",
            //         "stopped-threads": "all"
            //     }
            // }

            if (record.output.reason == "exited-normally") {
                this.sendEvent(new TerminatedEvent());
            } else {
                const threadId = parseInt(record.output["thread-id"]);
                if (isNaN(threadId)) {
                    loge(
                        `Failed to parse thread id from "${
                            record.output["thread-id"]
                        }" on stop event`,
                    );
                } else {
                    const event = new StoppedEvent(
                        record.output.reason,
                        threadId,
                    );

                    this.sendEvent(event);
                }
            }
        };

        this.debgugerInterface.outputEventNotifier = record => {
            logw(`Received output event with: ${JSON.stringify(record)}`);

            let outputCategory;
            switch (record.kind) {
                case "console-stream-output": {
                    outputCategory = "stdout";
                    break;
                }
                case "log-stream-output": {
                    // TODO: this is not necessarily always an error message
                    // I think?
                    outputCategory = "stderr";
                    break;
                }
                default: {
                    outputCategory = "console";
                    break;
                }
            }

            this.sendEvent(
                new OutputEvent(JSON.stringify(record.output), outputCategory),
            );
        };

        // TODO: handle the args
        try {
            const workDir = path.dirname(args.pathToBinary);
            await this.debgugerInterface.launch(workDir, args.args);
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            loge(`Failed to launch debugging session: ${err}`);
            this.sendErrorResponse(
                response,
                ErrorCodes.LaunchFailure,
                `Failed to launch: ${err}`,
            );
        }
    }

    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
    ): void {
        logw("ZigDebugSession:disconnect");

        this.debgugerInterface.kill();

        super.disconnectRequest(response, args);
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ) {
        logw("ZigDebugSession:breakpoints");

        response.body = { breakpoints: [] };
        const filename = args.source.name;

        // On every setBreakPointsRequest, VSCode will give us the full
        // list of breakpoints that need to be set. This includes breakpoints
        // that already exist. The user might set a breakpoint on a line
        // that does not contain any code, and therefore we must always refer
        // to the debugger to get the *actual* line of the breakpoint.
        // We can do this by setting the breakpoint on the line the user specified,
        // and then using the output from the debugger will tell us the actual line
        // of the breakpoint, so that we can keep track of it. This would mean
        // that we will potentially end up setting multiple breakpoints to the
        // same line because the user specified a line that we are not tracking
        // due to it not being a valid line.
        //
        // Each breakpoint has a unique number ID corresponding to it. So a single
        // line can have multiple breakpoints (the debugger is ok with this). To
        // avoid complicated tracking of breakpoints, we should first delete all
        // current live breakpoints, and then set the breakpoints again specified
        // in the arguments. This will allow us to keep track of only one breakpoint
        // per line, no matter the input from the user.
        //
        // This also helps when source has been modified.
        const liveBreakpoints = this.breakpoints.get(filename);
        if (liveBreakpoints) {
            for (const bId of liveBreakpoints.values()) {
                try {
                    await this.debgugerInterface.deleteBreakpoint(bId);
                } catch (err) {
                    loge(`Failed to delete breakpoint ${bId}: ${err}`);
                }
            }
        }

        const newBreakpoints = new Map<number, number>();

        // In order to avoid creating duplicate line breakpoints during the insert
        // breakpoint phase (we've already deleted the old breakpoints) we can
        // first sort the new breakpoint lines given as argument, then we
        // iterate over them and insert. On every insert, the debugger will
        // give us the actual line that the breakpoint was set at. We can use this
        // to ignore new breakpoints that are on lines that are less than the
        // previously returned breakpoint line from the debugger.
        //
        // Example program:
        // 1 | const warn = @import("std").debug.warn;
        // 2 |
        // 3 | pub fn main() void {
        // 4 |     warn("Hello!\n");
        // 5 | }
        //
        // Say the user marks lines 2, 3 and 4 as breakpoints. Our sorted
        // breakpoint list will be [2,3,4]. When we try to set a breakpoint on line 2
        // the debugger will tell us that it set it at line 4. This tell us that
        // from our breakpoint argument list ([2,3,4]) anything below 5, that is a
        // valid line for a breakpoint, has already been set. We can then ignore
        // lines 3, and 4, because the line that the debugger would set for these
        // has already been set (line 4).
        let selectedLines = args.lines.slice();
        // TODO: VSCode seems to be giving us the lines already sorted, however
        // the following algorithm requires a sorted list, so I am just being
        // cautious until I verify that args.lines is always be sorted.
        selectedLines.sort((a, b) => a - b);
        let nextAllowed = 0;
        for (const newB of selectedLines) {
            if (newB < nextAllowed) {
                continue;
            }

            try {
                const [
                    breakpointId,
                    breakpointLine,
                ] = await this.debgugerInterface.insertBreakpoint(
                    filename,
                    newB,
                );
                newBreakpoints.set(breakpointLine, breakpointId);

                response.body.breakpoints.push({
                    id: breakpointId,
                    verified: true,
                    line: breakpointLine,
                });
                nextAllowed = breakpointLine + 1;
            } catch (err) {
                loge(`Failed to set breakpoint at line <${newB}>: ${err}`);
                response.body.breakpoints.push({
                    verified: false,
                    line: newB,
                    message: err,
                });
            }
        }

        this.breakpoints.set(filename, newBreakpoints);
        this.sendResponse(response);
    }

    // At this point the debugger is up and VSCode has already told
    // us the initial breakpoints. Lets start the program.
    protected async configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
    ) {
        logw("ZigDebugSession:configDone");

        // TODO: stop on stopOnEntry true
        try {
            await this.debgugerInterface.run();
        } catch (err) {
            loge(`Failed to run: ${err}`);
        }
        // this.sendEvent(new StoppedEvent("breakpoint", 0));

        this.sendResponse(response);
    }

    private clearAllHandles() {
        this.stackFrameHandles.reset();
        this.variableHandles.reset();
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
        logw("ZigDebugSession:threadsRequest");

        response.body = {
            threads: [],
        };

        this.clearAllHandles();

        try {
            const threads = await this.debgugerInterface.threadInfo();
            for (const t of threads) {
                this.threadInfo.set(t.id, t);
                response.body.threads.push(new Thread(t.id, t.name));
            }
        } catch (err) {
            loge(`Failed to get threadInfo: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
    ) {
        logw("ZigDebugSession:stackTraceRequest");

        response.body = {
            stackFrames: [],
        };
        try {
            const threadInfo = this.threadInfo.get(args.threadId);
            if (!threadInfo) {
                throw new Error(
                    `stackTraceRequest with threadId ${
                        args.threadId
                    } that has no corresponding data`,
                );
            }

            response.body.stackFrames = threadInfo.frames.map(s => {
                const uniqueId = this.stackFrameHandles.create([
                    s.threadId,
                    s.level,
                ]);
                return new StackFrame(
                    uniqueId,
                    s.function,
                    new Source(s.file, s.filePath),
                    s.line,
                    0, // TODO: can we get column number from gdb/lldb?
                );
            });
        } catch (err) {
            loge(`Failed to get stack trace: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
    ) {
        logw("ZigDebugSession:scopesRequest");

        response.body = {
            scopes: [],
        };

        try {
            const [threadId, frameLevel] = this.stackFrameHandles.get(
                args.frameId,
            );
            const localVariables = await this.debgugerInterface.stackListVariables(
                threadId,
                frameLevel,
            );
            response.body.scopes.push(
                new Scope(
                    "Local",
                    this.variableHandles.create({
                        kind: "locals",
                        data: localVariables,
                    }),
                    false,
                ),
            );
        } catch (err) {
            loge(`Failed to get local variables: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
    ) {
        logw("ZigDebugSession:variablesRequest");

        response.body = {
            variables: [],
        };

        const varHandle = this.variableHandles.get(args.variablesReference);
        if (varHandle.kind === "locals") {
            // The UI is requesting the output we got for the local variables. Which
            // is the result from -stack-list-variables with the --simple-values option.
            response.body.variables = varHandle.data.map(localVar => {
                if (localVar.value === undefined) {
                    // No value came from the -stack-list-variables call. This is
                    // therefore a composite type. Lets be lazy and only get its
                    // data when the user actually wants to see it.
                    return new Variable(
                        localVar.name,
                        localVar.type,
                        this.variableHandles.create({
                            kind: "pending-eval",
                            type: localVar.type,
                            fullVarPath: localVar.name,
                        }),
                    );
                } else {
                    switch (localVar.value.kind) {
                        case "struct":
                        case "array":
                        case "slice-data":
                        case "pointer": {
                            // We should not be hitting these cases, since this is the locals output from
                            // -stack-list-variables with the --simple-values option there should only
                            // be undefined or simple values like numbers or characters.
                            loge(
                                `Received a composite type when it was not expected: ${localVar}`,
                            );
                            return new Variable("error", "error");
                            // return new Variable(
                            //     localVar.name,
                            //     localVar.type,
                            //     this.variableHandles.create({
                            //         kind: "inner-value",
                            //         fullVarPath: localVar.name,
                            //         data: localVar.value.data,
                            //     }),
                            // );
                        }
                        case "char":
                        case "int":
                        case "float": {
                            return new Variable(
                                localVar.name,
                                JSON.stringify(localVar.value.data),
                            );
                        }
                    }
                }
            });
        } else {
            let varOutput: MIOutputVariableParser.MIVariableOutput;

            let fullVarPath = varHandle.fullVarPath;

            // The UI wants to actually see the value of this composite type, due to
            // the user clicking on it.
            switch (varHandle.kind) {
                // Time to finally evaluate this variable to see its insides (we've been lazy
                // for performance up to this point).
                case "pending-eval": {
                    try {
                        const isPointer = varHandle.type.indexOf("*") !== -1;
                        if (isPointer) {
                            // For pointer types we want to see what they point to
                            fullVarPath = `(*${fullVarPath})`;
                            varOutput = await this.debgugerInterface.dataEval(
                                fullVarPath,
                            );
                        } else {
                            varOutput = await this.debgugerInterface.dataEval(
                                fullVarPath,
                            );
                        }
                    } catch (err) {
                        loge(
                            `Failed to retreive data for variable "${fullVarPath}": ${err}`,
                        );
                        this.sendResponse(response);
                        return;
                    }
                    break;
                }
                case "inner-value": {
                    varOutput = varHandle.data;
                    break;
                }
            }

            response.body.variables = this.defineVariables(
                fullVarPath,
                fullVarPath,
                varOutput,
            );
        }

        this.sendResponse(response);
    }

    private defineVariables(
        fullVarPath: string,
        name: string,
        varOutput: MIOutputVariableParser.MIVariableOutput,
        maxDepth = 1,
    ) {
        let variables = new Array<Variable>();

        switch (varOutput.kind) {
            case "struct": {
                if (maxDepth > 0) {
                    maxDepth--;
                    Object.keys(varOutput.data).map(k => {
                        // NOTE: the format .<key> is needed for the code in setVariableRequest.
                        // Do not change before viewing how it affects that code.
                        const newName = `.${k}`;
                        variables.push(
                            ...this.defineVariables(
                                fullVarPath + newName,
                                newName,
                                varOutput.data[k],
                                maxDepth,
                            ),
                        );
                    });
                } else {
                    variables.push(
                        new Variable(
                            name,
                            "",
                            this.variableHandles.create({
                                kind: "inner-value",
                                fullVarPath,
                                data: varOutput,
                            }),
                        ),
                    );
                }
                break;
            }
            case "array": {
                if (maxDepth > 0) {
                    maxDepth--;
                    varOutput.data.forEach((val, i) => {
                        // NOTE: the format [i] is needed for the code in setVariableRequest.
                        // Do not change before viewing how it affects that code.
                        const newName = `[${i}]`;
                        variables.push(
                            ...this.defineVariables(
                                fullVarPath + newName,
                                newName,
                                val,
                                maxDepth,
                            ),
                        );
                    });
                } else {
                    variables.push(
                        new Variable(
                            name,
                            "",
                            this.variableHandles.create({
                                kind: "inner-value",
                                fullVarPath,
                                data: varOutput,
                            }),
                        ),
                    );
                }
                break;
            }
            case "slice-data": {
                variables.push(new Variable(name, varOutput.data));
                break;
            }
            case "pointer": {
                variables.push(
                    new Variable(
                        name,
                        "",
                        this.variableHandles.create({
                            kind: "pending-eval",
                            fullVarPath,
                            // Unfortunately we don't have type information at this level, but
                            // we know this is a pointer to something. So lets tell our further code
                            // its a pointer by using "*"". NOTE: this is no longer valid if the
                            // code that checks to see if it's a pointer no longer looks for "*"".
                            type: "*",
                        }),
                    ),
                );
                break;
            }
            case "char":
            case "int":
            case "float": {
                variables.push(
                    new Variable(name, JSON.stringify(varOutput.data)),
                );
            }
        }

        return variables;
    }

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments,
    ) {
        logw("ZigDebugSession:continueRequest");

        try {
            await this.debgugerInterface.continue();
        } catch (err) {
            loge(`Failed to execute continue: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments,
    ) {
        logw("ZigDebugSession:nextRequest");

        try {
            await this.debgugerInterface.next(args.threadId);
        } catch (err) {
            loge(`Failed to execute next: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments,
    ) {
        logw("ZigDebugSession:stepInRequest");

        try {
            await this.debgugerInterface.step(args.threadId);
        } catch (err) {
            loge(`Failed to execute stepIn: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments,
    ) {
        logw("ZigDebugSession:stepOutRequest");

        try {
            await this.debgugerInterface.finish(args.threadId);
        } catch (err) {
            loge(`Failed to execute stepOut: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments,
    ) {
        logw("ZigDebugSession:pauseRequest");

        try {
            await this.debgugerInterface.interrupt();
        } catch (err) {
            loge(`Failed to execute pause: ${err}`);
        }

        this.sendResponse(response);
    }

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments,
    ) {
        logw("ZigDebugSession:evaluateRequest");

        // TODO: implement
        try {
            if (args.context == "repl") {
                const result = await this.debgugerInterface.evaluate(
                    args.expression,
                );
                response.body = {
                    result,
                    variablesReference: 0,
                };
            } else {
                // TODO: might need to handle different contexts differently
                // but for now this will mainly be triggered by the watch
                // context, which we can use the data evaluate command for.
                const result = await this.debgugerInterface.dataEval(
                    args.expression,
                );
                switch (result.kind) {
                    case "struct":
                    case "array": {
                        response.body = {
                            result: "",
                            variablesReference: this.variableHandles.create({
                                kind: "inner-value",
                                fullVarPath: args.expression,
                                data: result,
                            }),
                        };
                        break;
                    }
                    case "pointer": {
                        response.body = {
                            result: "",
                            variablesReference: this.variableHandles.create({
                                kind: "pending-eval",
                                // Wrapping like so (*(expr)) to avoid any issues when
                                // evaluating any expressions with deeper field access
                                // later on.
                                fullVarPath: `(*(${args.expression}))`,
                                type: "",
                            }),
                        };
                        break;
                    }
                    case "char":
                    case "int":
                    case "float": {
                        response.body = {
                            result: JSON.stringify(result.data),
                            variablesReference: 0,
                        };
                        break;
                    }
                }
            }
        } catch (err) {
            response.body = {
                result: err,
                variablesReference: 0,
            };
        }

        this.sendResponse(response);
    }

    protected async setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments,
    ) {
        const varHandle = this.variableHandles.get(args.variablesReference);

        let fullVariablePath;
        switch (varHandle.kind) {
            // We are setting a basic local variable. The name given in "args.name" is the full path.
            case "locals": {
                fullVariablePath = args.name;
                break;
            }

            // If our varHandle type is "pending-eval" it means that the parent of args.name
            // is of a composite type. It is "pending-eval" because that is how we define
            // the handle for the composite type when we initially get it from -stack-list-variables
            // (to lazily evaluate).

            // NOTE: We name our array element fields with the format [<number>], and
            // fields of a struct with the format .<name>. This means we can just append
            // args.name to the fullVarPath variable to get the full variable path we
            // are setting.
            // For example:
            //  - fullVarPath is "myArr" (an array) and args.name is "[0]", then the full variable path is "myArr[0]"
            //  - fullVarPath is "person" (a struct) and args.name is ".age", then the full variable path is "person.age"
            //  - fullVarPath is "person.scores" (an array) and args.name is "[1]", then "person.scores[1]"
            //  - fullVarPath is "personPtr" (a pointer) and args.name is ".age", then "(*personPtr).name"
            case "pending-eval": {
                const isPointer = varHandle.type.indexOf("*") != -1;
                const varName = isPointer
                    ? `(*${varHandle.fullVarPath})`
                    : `${varHandle.fullVarPath}`;
                fullVariablePath = `${varName}${args.name}`;
                break;
            }
            case "inner-value": {
                fullVariablePath = `${varHandle.fullVarPath}${args.name}`;
                break;
            }
        }

        try {
            const setExpr = `${fullVariablePath} = ${args.value}`;
            const setResponse = await this.debgugerInterface.dataEval(setExpr);
            response.body = {
                value: JSON.stringify(setResponse.data),
            };
        } catch (err) {
            loge(
                `Failed to set "${fullVariablePath}" with value <${
                    args.value
                }>: ${err}`,
            );
        }

        this.sendResponse(response);
    }
}

DebugSession.run(ZigDebugSession);
