"use strict";

import { DebugProtocol } from "vscode-debugprotocol";
import {
    DebugSession,
    LoggingDebugSession,
    Logger,
    logger,
    InitializedEvent,
    StoppedEvent,
} from "vscode-debugadapter";
import * as cp from "child_process";

namespace MIOutputParser {
    // Reference syntax:
    // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html#GDB_002fMI-Output-Syntax

    // const ->
    //      c-string
    function parseConst(miOutput: string, startAt: number): [number, string] {
        let i = startAt;
        while (miOutput[i] != '"') i++;
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
        let i = startAt;
        while (miOutput[i] != "=") i++;

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
                // TODO: do c-string's always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { type: "console-stream-output", output };
            }
            case "@": {
                // startAt 2 to skip over the first ".
                // TODO: do c-string's always start with " in mi output? Confirm with actual output.
                const [_, output] = parseConst(miOutput, 2);
                return { type: "target-stream-output", output };
            }
            case "&": {
                // startAt 2 to skip over the first ".
                // TODO: do c-string's always start with " in mi output? Confirm with actual output.
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

// This is what talks to gdb/lldb
class DebuggerInterface {
    private debuggerStartupCommand: string[];
    private debugProcess: cp.ChildProcess;

    // Whenever we write a command to be ran by the debuggers,
    // if we are expecting output, then we must register a callback
    // with the token (as the key) used in the input command.
    private callbackTable: Map<number, (data: any) => void>;

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

                const record = MIOutputParser.parseRecord(line);
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
        // Run the program
        logw("DebuggerInterface:run");
    }

    public kill() {
        // Terminate the program
        logw("DebuggerInterface:kill");
        this.debugProcess.kill();
    }

    public insertBreakpoint(
        shortFileName: string,
        lineNumber: number,
    ): Promise<[number, number]> {
        // Set breakpoint
        logw("DebuggerInterface:insertBreakpoint");

        const token = this.tokenCount++;
        const miCommand = `${token}-break-insert ${shortFileName}:${lineNumber}\n`;

        return new Promise((res, rej) => {
            const receive = (result: MIOutputParser.RecordOutput) => {
                logw(
                    `Received output for insertBreakpoint with token ${token}`,
                );

                if (result.class == "done" && result.output.bkpt) {
                    // Example outputs:
                    // lldb:
                    // bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00000001000235a8",func="main",file="main",fullname="src/main",line="7",times="0",original-location="main.zig:5"}
                    // gdb:
                    // bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00000001000235af",func="main",file="/Users/hchac/prj/playground/zig/test/src/main.zig",fullname="/Users/hchac/prj/playground/zig/test/src/main.zig",line="8",thread-groups=["i1"],times="0",original-location="main.zig:8"}
                    const bkpt = result.output.bkpt;

                    // This needs to be used as the identifier when deleting
                    // the breakpoint.
                    const breakpointID = bkpt.number;
                    if (!breakpointID) {
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
                        parseInt(breakpointID),
                        parseInt(actualBreakpointLine),
                    ]);
                } else if (result.class == "error" && result.output.msg) {
                    // Example output:
                    // '1^error,msg="No line 88 in file "main.zig"."'
                    return rej(result.output.msg);
                } else {
                    return rej(`Unexpected output: ${JSON.stringify(result)}`);
                }
            };

            // TODO: set some timeout for callback?
            this.callbackTable.set(token, receive);
            this.debugProcess.stdin.write(miCommand);
            logw(`Wrote ${miCommand}`);
        });
    }

    public deleteBreakpoint(breakpointID: number): Promise<number> {
        logw("DebuggerInterface:deleteBreakpoint");

        const token = this.tokenCount++;
        const miCommand = `${token}-break-delete ${breakpointID}\n`;

        return new Promise((res, rej) => {
            function receive(result: MIOutputParser.RecordOutput) {
                logw(
                    `Received output for deleteBreakpoint with token ${token}`,
                );

                if (result.class == "done") {
                    // Example output:
                    // 1^done
                    return res(breakpointID);
                } else if (result.class == "error" && result.output.msg) {
                    // Example:
                    // 12^error,msg="Command 'break-delete'. Breakpoint '4' invalid"
                    return rej(
                        `Error for command with token ${token}: ${
                            result.output.msg
                        }`,
                    );
                } else {
                    return rej(
                        `Unexpected output from delete breakpoint: ${JSON.stringify(
                            result,
                        )}`,
                    );
                }
            }

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
    //     lineNumber: <breakpointID>
    // }
    private breakpoints: Map<string, Map<number, number>>;

    public constructor(
        debuggerLinesStartAt1: boolean,
        isServer: boolean = false,
    ) {
        super("", debuggerLinesStartAt1, isServer);
        this.breakpoints = new Map();
    }

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments,
    ) {
        logw("ZigDebugSession:initialize");

        response.body.supportsConfigurationDoneRequest = true;

        this.sendResponse(response);
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
    ) {
        logw("ZigDebugSession:configDone");

        // TODO: only do this on stopOnEntry
        this.sendEvent(new StoppedEvent("breakpoint", 0));

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
            for (const bID of liveBreakpoints.values()) {
                try {
                    await this.debgugerInterface.deleteBreakpoint(bID);
                } catch (err) {
                    loge(`Failed to delete breakpoint ${bID}: ${err}`);
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
                    breakpointID,
                    breakpointLine,
                ] = await this.debgugerInterface.insertBreakpoint(
                    filename,
                    newB,
                );
                newBreakpoints.set(breakpointLine, breakpointID);

                response.body.breakpoints.push({
                    id: breakpointID,
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
}

DebugSession.run(ZigDebugSession);
