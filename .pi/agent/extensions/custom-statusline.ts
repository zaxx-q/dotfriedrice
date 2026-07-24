import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

interface RuntimeState {
	turnCount: number;
	activeTools: Map<string, number>;
	lastTool?: string;
	lastCompletedTool?: string;
	isStreaming: boolean;
	thinkingLevel: string;
	requestRender?: () => void;
}

export default function customStatusline(pi: ExtensionAPI) {
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
	};

	const refresh = () => runtime.requestRender?.();

	const installFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();

			const branchUnsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					branchUnsubscribe();
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [];
					
					// 1. Model
					const rawModel = ctx.model?.id ?? "no-model";
					const modelText = shortenModel(rawModel);
					const styledModel = theme.fg("accent", `🤖 ${modelText}`);

					// 2. Thinking level
					const thinking = runtime.thinkingLevel;
					const styledThinking = theme.fg(thinkingColor(thinking), `🧠 ${thinking}`);

					// 3. Current directory
					const dirText = basename(ctx.cwd) || ctx.cwd;
					const styledDir = theme.fg("muted", `📁 ${dirText}`);

					// 4. Active or last tool
					const toolActivity = formatToolActivity(runtime);
					const active = runtime.activeTools.size > 0;
					const styledTool = active 
						? theme.fg("accent", toolActivity)
						: runtime.lastCompletedTool 
							? theme.fg("success", toolActivity)
							: theme.fg("dim", toolActivity);

					// 5. Context usage
					const usage = ctx.getContextUsage();
					const tokens = usage?.tokens;
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
					const contextText = `🪟 ctx ${formatTokenCount(tokens)}/${formatTokenCount(contextWindow)}`;
					const percent = usage?.percent ?? (tokens && contextWindow ? (tokens / contextWindow) * 100 : 0);
					const styledContext = theme.fg(contextColor(percent), contextText);

					// 6. Token totals
					const totals = getTokenTotals(ctx);
					const styledTotals = theme.fg("muted", `🔢 ↑${formatTokenCount(totals.input)} ↓${formatTokenCount(totals.output)}`);

					// Separator
					const sep = theme.fg("dim", " │ ");

					// Combine segments
					const combined = [
						styledModel,
						styledThinking,
						styledDir,
						styledTool,
						styledContext,
						styledTotals
					].join(sep);

					// Truncate to make sure it fits perfectly
					return [truncateToWidth(combined, width, "")];
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		runtime.requestRender = undefined;
	});

	pi.on("model_select", () => refresh());

	pi.on("thinking_level_select", (event) => {
		runtime.thinkingLevel = event.level;
		refresh();
	});

	pi.on("agent_start", () => {
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("agent_end", () => {
		runtime.isStreaming = false;
		refresh();
	});

	pi.on("turn_start", () => {
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("turn_end", () => refresh());

	pi.on("tool_execution_start", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		runtime.lastTool = event.toolName;
		refresh();
	});

	pi.on("tool_execution_end", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		runtime.lastCompletedTool = event.toolName;
		refresh();
	});
}

function shortenModel(model: string): string {
	return model
		.replace(/^claude-/, "")
		.replace(/^gpt-/, "gpt ")
		.replace(/-20\d{6}$/, "")
		.replace(/-latest$/, "");
}

function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "off":
			return "dim";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "dim";
	}
}

function contextColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function formatToolActivity(runtime: RuntimeState): string {
	const active = [...runtime.activeTools.keys()];
	if (active.length > 0) {
		const name = active[0];
		const count = runtime.activeTools.get(name) ?? 1;
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return `⚙ ${name}${suffix}`;
	}

	if (runtime.isStreaming) return "💭 thinking";
	if (runtime.lastCompletedTool) return `✅ ${runtime.lastCompletedTool}`;
	return "💤 idle";
}

interface TokenTotals {
	input: number;
	output: number;
}

function getTokenTotals(ctx: ExtensionContext): TokenTotals {
	const totals: TokenTotals = { input: 0, output: 0 };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const usage = entry.message.usage as
			| {
					input?: number;
					output?: number;
			  }
			| undefined;

		totals.input += usage?.input ?? 0;
		totals.output += usage?.output ?? 0;
	}

	return totals;
}

function formatTokenCount(value: number | undefined | null): string {
	if (value === undefined || value === null) return "?";
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) {
		const k = value / 1000;
		return `${k.toFixed(k < 10 ? 1 : 0)}k`;
	}
	const m = value / 1_000_000;
	return `${m.toFixed(m < 10 ? 1 : 0)}m`;
}
