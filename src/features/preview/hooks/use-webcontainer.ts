import { useCallback, useEffect, useRef, useState } from "react";
import { WebContainer } from "@webcontainer/api";

import {
  buildFileTree,
  getFilePath
} from "@/features/preview/utils/file-tree";
import { useFiles } from "@/features/projects/hooks/use-files";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

// Singleton WebContainer instance
let webcontainerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

type FileRecord = {
  path: string;
  content?: string;
};

type PreviewWorkspace = {
  cwd: string;
  packageJsonPath: string;
};

type ResolvedCommands = {
  cwd: string;
  installCommand: string;
  devCommand: string;
};

const splitCommand = (command: string) => {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) =>
    part.replace(/^['"]|['"]$/g, "")
  );
};

const getDirname = (path: string) => {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
};

const getFileRecords = (files: ReturnType<typeof useFiles>): FileRecord[] => {
  const filesMap = new Map(files?.map((file) => [file._id, file]));

  return (files ?? [])
    .filter((file) => file.type === "file")
    .map((file) => ({
      path: getFilePath(file, filesMap),
      content: file.content,
    }));
};

const parsePackageJson = (content?: string) => {
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as {
      scripts?: Record<string, string>;
      workspaces?: unknown;
    };
  } catch {
    return null;
  }
};

const resolvePreviewWorkspace = (files: ReturnType<typeof useFiles>): PreviewWorkspace | null => {
  const records = getFileRecords(files);
  const paths = new Set(records.map((record) => record.path));

  const packageJsonCandidates = records
    .filter((record) => record.path.endsWith("package.json"))
    .map((record) => {
      const cwd = getDirname(record.path);
      const packageJson = parsePackageJson(record.content);
      const scripts = packageJson?.scripts ?? {};
      const prefix = cwd ? `${cwd}/` : "";

      let score = 0;

      if (scripts.dev) {
        score += 10;
      }

      if (scripts.start) {
        score += 4;
      }

      if (paths.has(`${prefix}next.config.ts`) || paths.has(`${prefix}next.config.js`)) {
        score += 3;
      }

      if (paths.has(`${prefix}vite.config.ts`) || paths.has(`${prefix}vite.config.js`)) {
        score += 3;
      }

      if (paths.has(`${prefix}index.html`)) {
        score += 2;
      }

      if (packageJson?.workspaces) {
        score -= 5;
      }

      score -= cwd ? cwd.split("/").length : 0;

      return {
        cwd,
        packageJsonPath: record.path,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  return packageJsonCandidates[0] ?? null;
};

const resolveDefaultCommands = (files: ReturnType<typeof useFiles>, cwd: string) => {
  const paths = new Set(getFileRecords(files).map((record) => record.path));
  const prefix = cwd ? `${cwd}/` : "";

  if (paths.has(`${prefix}pnpm-lock.yaml`)) {
    return {
      installCommand: "pnpm install",
      devCommand: "pnpm dev",
    };
  }

  if (paths.has(`${prefix}yarn.lock`)) {
    return {
      installCommand: "yarn install",
      devCommand: "yarn dev",
    };
  }

  if (paths.has(`${prefix}bun.lock`) || paths.has(`${prefix}bun.lockb`)) {
    return {
      installCommand: "bun install",
      devCommand: "bun dev",
    };
  }

  return {
    installCommand: "npm install",
    devCommand: "npm run dev",
  };
};

const resolveCommands = (
  files: ReturnType<typeof useFiles>,
  settings: UseWebContainerProps["settings"],
  workspace: PreviewWorkspace
): ResolvedCommands => {
  const defaults = resolveDefaultCommands(files, workspace.cwd);
  const cwd = settings?.rootDirectory ?? workspace.cwd;

  return {
    cwd,
    installCommand: settings?.installCommand || defaults.installCommand,
    devCommand: settings?.devCommand || defaults.devCommand,
  };
};

const getWebContainer = async (): Promise<WebContainer> => {
  if (webcontainerInstance) {
    return webcontainerInstance;
  }

  if (!bootPromise) {
    bootPromise = WebContainer.boot({ coep: "credentialless" });
  }

  webcontainerInstance = await bootPromise;
  return webcontainerInstance;
};

const teardownWebContainer = () => {
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
    webcontainerInstance = null;
  }
  bootPromise = null;
};

interface UseWebContainerProps {
  projectId: Id<"projects">;
  enabled: boolean;
  settings?: {
    installCommand?: string;
    devCommand?: string;
    rootDirectory?: string;
  };
};

export const useWebContainer = ({
  projectId,
  enabled,
  settings,
}: UseWebContainerProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");

  const containerRef = useRef<WebContainer | null>(null);
  const hasStartedRef = useRef(false);

  // Fetch files from Convex (auto-updates on changes)
  const files = useFiles(projectId);

  // Initial boot and mount
  useEffect(() => {
    if (!enabled || !files || files.length === 0 || hasStartedRef.current) {
      return;
    }

    hasStartedRef.current = true;

    const start = async () => {
      try {
        setStatus("booting");
        setError(null);
        setTerminalOutput("");
        setPreviewUrl(null);

        const appendOutput = (data: string) => {
          setTerminalOutput((prev) => prev + data);
        };

        appendOutput("🔄 Preparing environment...\n");

        const workspace = resolvePreviewWorkspace(files);

        if (!workspace) {
          throw new Error(
            "Preview requires a runnable app with a package.json file. Ask the AI to generate a complete project, or add package.json manually."
          );
        }

        const commands = resolveCommands(files, settings, workspace);

        const container = await getWebContainer();
        containerRef.current = container;

        const fileTree = buildFileTree(files);
        appendOutput(`📁 Mounting ${files.length} files...\n`);
        await container.mount(fileTree);

        appendOutput(`Detected app root: /${workspace.cwd || "."}\n`);
        appendOutput(`Using package.json: /${workspace.packageJsonPath}\n\n`);

        container.on("server-ready", (_port, url) => {
          setPreviewUrl(url);
          setStatus("running");
        });

        setStatus("installing");

        const installParts = splitCommand(commands.installCommand);
        const [installBin, ...installArgs] = installParts;

        if (!installBin) {
          throw new Error("Preview install command is empty.");
        }

        appendOutput(`$ ${commands.installCommand}\n`);
        const installProcess = await container.spawn(installBin, installArgs, {
          cwd: commands.cwd,
        });
        installProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          })
        );
        const installExitCode = await installProcess.exit;

        if (installExitCode !== 0) {
          throw new Error(
            `${commands.installCommand} failed with code ${installExitCode}`
          );
        }

        const devParts = splitCommand(commands.devCommand);
        const [devBin, ...devArgs] = devParts;

        if (!devBin) {
          throw new Error("Preview start command is empty.");
        }

        appendOutput(`\n$ ${commands.devCommand}\n`);
        const devProcess = await container.spawn(devBin, devArgs, {
          cwd: commands.cwd,
        });
        devProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          })
        );
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unknown error");
        setStatus("error");
      }
    };

    start();
  }, [
    enabled,
    files,
    restartKey,
    settings?.devCommand,
    settings?.installCommand,
  ]);

  // Sync file changes (hot-reload)
  const previousFilesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !files || status !== "running") return;

    const syncFiles = async () => {
      const filesMap = new Map(files.map((f) => [f._id, f]));
      const currentPreviousFiles = previousFilesRef.current;
      const nextPreviousFiles = new Map<string, string>();

      for (const file of files) {
        if (file.type !== "file" || file.storageId) continue;

        const filePath = getFilePath(file, filesMap);
        const content = file.content ?? "";

        // Only write if the content has changed
        if (currentPreviousFiles.get(filePath) !== content) {
          await container.fs.writeFile(filePath, content);
        }

        nextPreviousFiles.set(filePath, content);
      }

      previousFilesRef.current = nextPreviousFiles;
    };

    syncFiles();
  }, [files, status]);

  // Reset when disabled
  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);
    }
  }, [enabled]);

  // Restart the entire WebContainer process
  const restart = useCallback(() => {
    teardownWebContainer();
    containerRef.current = null;
    hasStartedRef.current = false;
    setStatus("idle");
    setPreviewUrl(null);
    setError(null);
    setRestartKey((k) => k + 1);
  }, []);

  return {
    status,
    previewUrl,
    error,
    restart,
    terminalOutput,
  };
};
