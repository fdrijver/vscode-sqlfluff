import * as CProcess from "child_process";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import * as vscode from "vscode";

import Configuration from "../helper/configuration";
import { LineDecoder } from "../helper/lineDecoder";
import { Osmosis } from "../helper/osmosis";
import Utilities from "../helper/utilities";
import FilePath from "./linter/types/filePath";
import CommandOptions from "./types/commandOptions";
import CommandOutput from "./types/commandOutput";
import CommandType from "./types/commandType";

export default class SQLFluff {
  static childProcesses: CProcess.ChildProcess[] = [];

  public static async run(
    workingDirectory: string | undefined,
    command: CommandType,
    args: string[],
    options: CommandOptions
  ): Promise<CommandOutput> {
    if (!options.fileContents && !options.filePath) {
      throw new Error("You must supply either a target file path or the file contents to scan");
    }

    // This is an unlikely scenario, but we should limit the amount of processes happening at once.
    while (SQLFluff.childProcesses.length > 10) {
      const process = SQLFluff.childProcesses.shift();
      process?.kill("SIGKILL");
    }

    const normalizedWorkingDirectory = workingDirectory ? Utilities.normalizePath(workingDirectory) : undefined;
    const shouldUseStdin = !!options.fileContents?.length;
    const finalArgs = [command, ...args, ...Configuration.extraArguments()];

    Utilities.appendHyphenatedLine();
    if (shouldUseStdin) {
      Utilities.outputChannel.appendLine("Reading from stdin, not file, input may be dirty/partial");
      finalArgs.push("-");
    } else if (options.workspacePath) {
      Utilities.outputChannel.appendLine("Reading from workspace, not stdin");
    } else {
      Utilities.outputChannel.appendLine("Reading from file, not stdin");
      // We want to use relative path to the file so intermediate sqlfluff config files can be found
      const normalizedFilePath = Utilities.normalizePath(options.filePath);
      const targetFileRelativePath = normalizedWorkingDirectory
        ? Utilities.normalizePath(path.relative(normalizedWorkingDirectory, normalizedFilePath))
        : normalizedFilePath;
      finalArgs.push(targetFileRelativePath);
    }

    if (Configuration.osmosisEnabled() && command === CommandType.LINT) {
      const osmosis = new Osmosis(
        shouldUseStdin ? options.fileContents : undefined,
        options.workspacePath ?? options.filePath,
        Configuration.config()
      );

      Utilities.outputChannel.appendLine("\n--------------------Executing Command--------------------\n");
      Utilities.outputChannel.appendLine(osmosis.getURL());
      if (shouldUseStdin) {
        Utilities.outputChannel.appendLine("\n-----Request Body-----\n");
        if (options.fileContents) {
          Utilities.outputChannel.appendLine(options.fileContents);
        } else {
          Utilities.outputChannel.appendLine("ERROR: File contents not found.");
        }
      }

      Utilities.appendHyphenatedLine();

      const response: any = await osmosis.lint();
      const output: FilePath[] = [
        {
          filepath: options.filePath,
          violations: response.result ?? [],
        },
      ];

      Utilities.outputChannel.appendLine("Raw dbt-omsosis /lint output:");
      Utilities.appendHyphenatedLine();
      Utilities.outputChannel.appendLine(JSON.stringify(response, undefined, 2));
      Utilities.appendHyphenatedLine();

      return new Promise<CommandOutput>((resolve) => {
        const code = response?.error?.code ?? 0;
        const succeeded = code === 0;
        if (!succeeded && !Configuration.suppressNotifications()) {
          const message = response?.error?.message ?? "DBT-Osmosis linting error.";
          const detail = response?.error?.data?.error ?? "";

          vscode.window.showErrorMessage([message, detail].join("\n"));
        }

        resolve({
          // 0 = all good, 1 = format passed but contains unfixable linting violations, 65 = lint passed but found errors
          succeeded: succeeded,
          lines: [JSON.stringify(output)],
        });
      });
    }

    return new Promise<CommandOutput>((resolve) => {
      const stdoutLint = new LineDecoder();
      const stdoutFix: Buffer[] = [];
      let stdoutLines: string[];
      const stderrLines: string[] = [];

      const onStdoutDataEvent = (data: Buffer) => {
        if (command === CommandType.LINT) {
          stdoutLint.write(data);
        } else {
          stdoutFix.push(data);
        }
      };

      const onStderrDataEvent = (data: Buffer) => {
        stderrLines.push(data.toString("utf8"));
      };

      const onCloseEvent = (code: number | null, signal: any, process: CProcess.ChildProcess) => {
        Utilities.outputChannel.appendLine(`Received close event, code ${code} signal ${signal}`);
        Utilities.outputChannel.appendLine("Raw stdout output:");

        Utilities.appendHyphenatedLine();
        if (command === CommandType.LINT) {
          stdoutLint.end();
          stdoutLines = stdoutLint.getLines();
          Utilities.outputChannel.appendLine(stdoutLines.join("\n"));
        } else {
          const encoding: BufferEncoding = "utf8";
          const stringDecoder = new StringDecoder(encoding);

          const stdoutAllLines = stdoutFix.reduce((response, buffer) => {
            response += stringDecoder.write(buffer);
            return response;
          }, "");
          stdoutLines = [stdoutAllLines];
          Utilities.outputChannel.appendLine(stdoutLines.join("\n"));
        }
        Utilities.appendHyphenatedLine();

        if (stderrLines.length > 0) {
          Utilities.outputChannel.appendLine("Raw stderr output:");
          Utilities.appendHyphenatedLine();
          Utilities.outputChannel.appendLine(stderrLines.join("\n"));
          Utilities.appendHyphenatedLine();
        }

        if (stderrLines?.length > 0 && !Configuration.suppressNotifications()) {
          const stderrString = stderrLines.join("\n");
          if (!stderrString.includes("ignored by a .sqlfluffignore pattern")) {
            vscode.window.showErrorMessage(stderrString);
          }
        }

        this.childProcesses = this.childProcesses.filter(childProcess => childProcess !== process);

        return resolve({
          // 0 = all good, 1 = format passed but contains unfixable linting violations, 65 = lint passed but found errors
          succeeded: code === 0 || code === 1 || code === 65,
          lines: stdoutLines,
        });
      };

      Utilities.outputChannel.appendLine("\n--------------------Executing Command--------------------\n");
      Utilities.outputChannel.appendLine(Configuration.executablePath() + " " + finalArgs.join(" "));
      Utilities.appendHyphenatedLine();

      const environmentVariables = Configuration.environmentVariables(process.env);

      const childProcess = CProcess.spawn(
        Configuration.executablePath(),
        finalArgs,
        {
          cwd: normalizedWorkingDirectory,
          env: environmentVariables,
        }
      );

      SQLFluff.childProcesses.push(childProcess);

      if (childProcess.pid) {
        childProcess.stdout.on("data", onStdoutDataEvent);
        childProcess.stderr.on("data", onStderrDataEvent);
        childProcess.on("close", (code, number) => onCloseEvent(code, number, childProcess));
        if (shouldUseStdin) {
          childProcess.stdin.write(options.fileContents);
          childProcess.stdin.end();
        }
      }

      childProcess.on("message", (message) => {
        Utilities.outputChannel.appendLine("Received message from child process");
        Utilities.outputChannel.appendLine(message.toString());
      });

      childProcess.on("error", (error: Error) => {
        Utilities.outputChannel.appendLine("Child process threw error");
        Utilities.outputChannel.appendLine(error.toString());
        let { message } = error;

        if ((error as any).code === "ENOENT") {
          message = "The sqlfluff executable was not found. ";
          message += "Use the 'Executable Path' setting to configure the location of the executable, or add it to your PATH.";
        }

        if (!Configuration.suppressNotifications()) {
          vscode.window.showErrorMessage(message);
        }

        resolve({ succeeded: false, lines: [] });
      });
    });
  }
}
