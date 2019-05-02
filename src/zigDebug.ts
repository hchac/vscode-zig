"use strict";

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
} from "vscode-debugadapter";
import * as cp from "child_process";

namespace MIOutputParser {
    // Reference syntax:
    // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html#GDB_002fMI-Output-Syntax

    // Examples:
    // Array of u8:                    "{[0] = 104 'h', [1] = 101 'e', [2] = 108 'l', [3] = 108 'l', [4] = 111 'o'}"
    // Array of i32|u32:               "{[0] = 1, [1] = 2}"
    // Pointer:                        "{tag = (none), value = 0x0000000100200080}"
    // Slice:                          "{ptr = 0x0000000100031de0 \"Hello\", len = 5}"
    // Struct {name: []u8, age: i32}:  "{name = {ptr = 0x0000000100032dc0 \"Bob\", len = 3}, age = 33}"
    // Struct {name: [3]u8, age: i32}: "{name = {[0] = 66 'B', [1] = 111 'o', [2] = 98 'b'}, age = 33}"
    function parseSpecialConst(
        miOutput: string,
        startAt: number,
    ): [number, any] {
        // TODO: Turn every example above into an appropriate object

        // For now we are just going to find the end and return a string.
        let i = startAt;
        let closingBraceStack = 1;
        while (true) {
            if (miOutput[i] == "}") {
                if (closingBraceStack == 1) break;
                closingBraceStack--;
            } else if (miOutput[i] == "{") {
                closingBraceStack++;
            }
            i++;
        }

        return [i, miOutput.slice(startAt, i)];
    }

    // const ->
    //      c-string
    function parseConst(miOutput: string, startAt: number): [number, string] {
        if (miOutput[startAt] == "{") {
            const [endedAt, result] = parseSpecialConst(miOutput, startAt + 1);
            // +1 to end at the last '"'
            return [endedAt + 1, result];
        }

        const endedAt = miOutput.indexOf('"', startAt);
        return [endedAt, miOutput.slice(startAt, endedAt)];
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
        type:
            | "console-stream-output"
            | "target-stream-output"
            | "log-stream-output";
        output: string;
    };

    export type RecordOutput = {
        type:
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
            case "-": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { type: "console-stream-output", output };
            }
            case "@": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { type: "target-stream-output", output };
            }
            case "&": {
                // startAt 2 to skip over the first ".
                // TODO: do c-strings always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { type: "log-stream-output", output };
            }
            case "*": {
                return {
                    type: "exec-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "+": {
                return {
                    type: "status-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "=": {
                return {
                    type: "notify-async-output",
                    token,
                    ...parseAsyncOutput(miOutput, i + 1),
                };
            }
            case "^": {
                return {
                    type: "result-record",
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
    value: string;
    // TODO: add type info
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

    constructor(pathToExectuable: string) {
        logw("DebuggerInterface:constructor");

        this.tokenCount = 0;
        this.callbackTable = new Map();
        this.stopEventNotifier = undefined;

        // ****************************************************
        // TODO: find gdb or lldb-mi

        // NOTE: gdb requires code signing on macOS. The following was
        // written for lldb, but apparently works for gdb too.
        // https://opensource.apple.com/source/lldb/lldb-69/docs/code-signing.txt
        // this.debuggerUsed = "gdb";
        // this.debuggerStartupCommand = ["gdb", "-quiet", "--interpreter=mi2"];

        // Requires Xcode installed:
        this.debuggerUsed = "lldb";
        this.debuggerStartupCommand = [
            "/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-mi",
            "--interpreter=mi2",
        ];
        // ****************************************************

        this.debuggerStartupCommand.push(pathToExectuable);
    }

    public async launch(cwd: string) {
        // Start up the debugger
        logw("DebuggerInterface:launch");

        this.debugProcess = cp.spawn(
            this.debuggerStartupCommand[0],
            this.debuggerStartupCommand.slice(1),
            {
                cwd,
                env: {
                    ...process.env,
                    // TODO: do this properly
                    // LLDB requires macOS'strData python, therefore we must
                    // make sure it'strData selected over brew'strData.
                    ...(this.debuggerUsed == "lldb"
                        ? { PATH: "/usr/bin:" + process.env.PATH }
                        : {}),
                },
            },
        );

        // Wait for initialization to finish
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
            throw new Error("Failed to launch");
        }

        // We're done with the initialization phase, lets
        // clear the init event handlers and set the regular
        // handlers.
        // TODO: does this clear all handlers, including
        // the ones in this.debugProcess.stdout, etc?
        this.debugProcess.removeAllListeners();

        // Set the standard event handlers at this point
        this.debugProcess.on("error", err => {
            loge(`Got an error: ${err}`);
            // TODO: only kill when necessary
            this.kill();
        });

        // this.debugProcess.stdout.removeAllListeners();
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

                if (record.type == "result-record" && record.token != null) {
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
                    record.type == "exec-async-output" &&
                    record.class == "stopped" &&
                    this.stopEventNotifier
                ) {
                    this.stopEventNotifier(record);
                } else {
                    logw(`miOutput: ${JSON.stringify(record)}`);
                }
            }
        });

        // this.debugProcess.stderr.removeAllListeners();
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

    // public stackTrace(threadId: number): Promise<StackFrameInfo[]> {
    //     logw("DebuggerInterface:stackTrace");

    //     const token = this.tokenCount++;
    //     const miCommand = `${token}-stack-list-frames --thread ${threadId}\n`;

    //     return new Promise((res, rej) => {
    //         const receive = (result: MIOutputParser.RecordOutput) => {
    //             logw(`Received output for stackTrace with token ${token}`);
    //             this.callbackTable.delete(token);

    //             if (result.class == "done" && result.output.stack) {
    //                 let results = new Array<StackFrameInfo>();

    //                 for (const frameObj of result.output.stack) {
    //                     const frame = frameObj.frame;
    //                     if (!frame) continue;

    //                     // Example output that we should avoid processing:
    //                     // {
    //                     //     "level": "4",
    //                     //     "addr": "0x00007fff652773d5",
    //                     //     "func": "start",
    //                     //     "file": "??",
    //                     //     "fullname": "??",
    //                     //     "line": "-1"
    //                     // }
    //                     if (
    //                         frame.line == "-1" ||
    //                         frame.file == "??" ||
    //                         frame.fullname == "??"
    //                     )
    //                         continue;

    //                     const level = parseInt(frame.level);
    //                     if (isNaN(level)) {
    //                         loge(
    //                             `Failed to parse frame level from "${
    //                                 frame.level
    //                             }"`,
    //                         );
    //                     }

    //                     const line = parseInt(frame.line);
    //                     if (isNaN(line)) {
    //                         loge(
    //                             `Failed to parse frame line from "${
    //                                 frame.line
    //                             }"`,
    //                         );
    //                     }

    //                     results.push({
    //                         threadId,
    //                         level,
    //                         address: frame.addr,
    //                         function: frame.func,
    //                         file: frame.file,
    //                         filePath: frame.fullname,
    //                         line,
    //                     });
    //                 }

    //                 return res(results);
    //             } else if (result.class == "error" && result.output.msg) {
    //                 return rej(
    //                     `Error for stackTrace with token ${token}: ${
    //                         result.output.msg
    //                     }`,
    //                 );
    //             } else {
    //                 return rej(
    //                     `Unexpected output from stackTrace: ${JSON.stringify(
    //                         result,
    //                     )}`,
    //                 );
    //             }
    //         };

    //         // TODO: set some timeout for callback?
    //         this.callbackTable.set(token, receive);
    //         this.debugProcess.stdin.write(miCommand);
    //         logw(`Wrote ${miCommand}`);
    //     });
    // }

    public stackListVariables(
        threadId: number,
        frameLevel: number,
    ): Promise<StackVariable[]> {
        logw("DebuggerInterface:stackListVariables");

        const token = this.tokenCount++;
        // TODO: this gives both local and arguments, maybe seperate them in the future?
        const miCommand = `${token}-stack-list-variables --thread ${threadId} --frame ${frameLevel} --all-values\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(
                    `Received output for stackListVariables with token ${token}`,
                );
                this.callbackTable.delete(token);

                if (result.class == "done" && result.output.variables) {
                    let results = new Array<StackVariable>();
                    for (const v of result.output.variables) {
                        results.push({
                            name: v.name,
                            value: v.value,
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
    // TODO: add the settings from package.json
    projectRoot: string;
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
    private variableHandles: Handles<StackVariable[]>;

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

        this.sendResponse(response);
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchSettings,
    ) {
        logw("ZigDebugSession:launch");
        logger.setup(Logger.LogLevel.Verbose);

        // TODO: don't hardcode the path to executable
        this.debgugerInterface = new DebuggerInterface("main");
        this.debgugerInterface.stopEventNotifier = record => {
            logw(`Received stop event with: ${JSON.stringify(record)}`);
            // Example record:     TODO: create type for this
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
                        // TODO: does VSCode want the exact reasons specified in the link below?
                        record.output.reason,
                        threadId,
                    );

                    // TODO: set additional properties specified at:
                    // https://microsoft.github.io/debug-adapter-protocol/specification#Events_Stopped

                    this.sendEvent(event);
                }
            }
        };

        // TODO: handle the args
        try {
            await this.debgugerInterface.launch(args.projectRoot);
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            loge(`Failed to launch debugging session: ${err}`);
            // TODO: Use a table/enum to maintain error codes
            this.sendErrorResponse(response, 1234, `Failed to launch: ${err}`);
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
        selectedLines.sort();
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

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
        logw("ZigDebugSession:threadsRequest");

        response.body = {
            threads: [],
        };
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
            // const stacks = await this.debgugerInterface.stackTrace(
            //     args.threadId,
            // );
            // response.body.stackFrames = stacks.map(s => {
            //     const uniqueId = this.stackFrameHandles.create([
            //         s.threadId,
            //         s.level,
            //     ]);
            //     return new StackFrame(
            //         uniqueId,
            //         s.function,
            //         new Source(s.file, s.filePath),
            //         s.line,
            //         0, // TODO: can we get column number from gdb/lldb?
            //     );
            // });

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
                    this.variableHandles.create(localVariables),
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

        const variables = this.variableHandles.get(args.variablesReference);
        response.body.variables = variables.map(v => {
            return new Variable(v.name, v.value);
        });

        this.sendResponse(response);
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
}

DebugSession.run(ZigDebugSession);
