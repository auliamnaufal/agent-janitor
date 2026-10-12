import path from "node:path";

export interface ScheduleFile {
  path: string;
  content: string;
}

export interface SchedulePlan {
  platform: NodeJS.Platform;
  files: ScheduleFile[];
  activate: string[];
}

function parseAt(at: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!match) return { hour: 12, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function launchdPlist(binPath: string, home: string, hour: number, minute: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agent-janitor.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>watch</string>
    <string>--home</string>
    <string>${home}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
</dict>
</plist>
`;
}

/**
 * Generates the scheduler artifacts for a weekly `watch`. Files are written under
 * the user's home; registration commands are printed, never run automatically
 * unless the caller passes --apply.
 */
export function buildSchedule(opts: {
  home: string;
  binPath: string;
  at: string;
  platform?: NodeJS.Platform;
}): SchedulePlan {
  const platform = opts.platform ?? process.platform;
  const { hour, minute } = parseAt(opts.at);

  if (platform === "darwin") {
    const file = path.join(opts.home, "Library", "LaunchAgents", "dev.agent-janitor.watch.plist");
    return {
      platform,
      files: [{ path: file, content: launchdPlist(opts.binPath, opts.home, hour, minute) }],
      activate: [`launchctl load "${file}"`],
    };
  }

  if (platform === "linux") {
    const dir = path.join(opts.home, ".config", "systemd", "user");
    const service = `[Unit]
Description=agent-janitor weekly watch

[Service]
Type=oneshot
ExecStart=${opts.binPath} watch --home ${opts.home}
`;
    const timer = `[Unit]
Description=agent-janitor weekly watch timer

[Timer]
OnCalendar=Mon ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}
Persistent=true

[Install]
WantedBy=timers.target
`;
    return {
      platform,
      files: [
        { path: path.join(dir, "agent-janitor-watch.service"), content: service },
        { path: path.join(dir, "agent-janitor-watch.timer"), content: timer },
      ],
      activate: ["systemctl --user daemon-reload", "systemctl --user enable --now agent-janitor-watch.timer"],
    };
  }

  return {
    platform,
    files: [],
    activate: [
      `schtasks /Create /SC WEEKLY /D MON /ST ${opts.at} /TN agent-janitor-watch /TR "${opts.binPath} watch --home ${opts.home}"`,
    ],
  };
}
