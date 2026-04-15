import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";

// ─── State ───────────────────────────────────────────────────────────────────

let server: http.Server | undefined;
let startTime = 0;
let statusBarItem: vscode.StatusBarItem;
const output = vscode.window.createOutputChannel("Kunilingus Bridge");

// Terminal management
const managedTerminals = new Map<string, vscode.Terminal>();
let terminalIdCounter = 0;

// Auto-accept mode — auto-clicks "Allow", "Keep", trust dialogs, etc.
let autoAcceptEnabled = true;

// Message queue for polling (allows external clients to retrieve /say messages via GET /messages)
interface QueuedMessage {
	message: string;
	mode: string;
	timestamp: string;
	id: string;
}
const messageQueue: QueuedMessage[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BridgeConfig {
	port: number;
	autoStart: boolean;
	apiKey: string;
	defaultModel: string;
}

function getConfig(): BridgeConfig {
	const cfg = vscode.workspace.getConfiguration("kunilingus-bridge");
	return {
		port: cfg.get("port", 3789),
		autoStart: cfg.get("autoStart", true),
		apiKey: cfg.get("apiKey", ""),
		defaultModel: cfg.get("defaultModel", ""),
	};
}

function log(msg: string): void {
	const ts = new Date().toISOString();
	output.appendLine(`[${ts}] ${msg}`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => (data += chunk.toString()));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function setCors(res: http.ServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function checkAuth(req: http.IncomingMessage, apiKey: string): boolean {
	if (!apiKey) {
		return true;
	}
	const auth = req.headers["authorization"];
	return auth === `Bearer ${apiKey}`;
}

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

function buildMessages(
	messages: ChatMessage[],
	systemPrompt?: string
): vscode.LanguageModelChatMessage[] {
	const result: vscode.LanguageModelChatMessage[] = [];
	if (systemPrompt) {
		result.push(vscode.LanguageModelChatMessage.User(`[System] ${systemPrompt}`));
	}
	for (const m of messages) {
		if (m.role === "user") {
			result.push(vscode.LanguageModelChatMessage.User(m.content));
		} else {
			result.push(vscode.LanguageModelChatMessage.Assistant(m.content));
		}
	}
	return result;
}

async function pickModel(
	preferredFamily?: string
): Promise<vscode.LanguageModelChat | undefined> {
	const selector: vscode.LanguageModelChatSelector = {};
	if (preferredFamily) {
		selector.family = preferredFamily;
	}
	const models = await vscode.lm.selectChatModels(selector);
	if (models.length === 0 && preferredFamily) {
		const all = await vscode.lm.selectChatModels({});
		return all[0];
	}
	return models[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBody(raw: string, res: http.ServerResponse): any | null {
	try {
		return JSON.parse(raw);
	} catch {
		sendJson(res, 400, { error: "Invalid JSON body" });
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Status ──────────────────────────────────────────────────────────────────

async function handleStatus(res: http.ServerResponse): Promise<void> {
	const cfg = getConfig();
	const folders = (vscode.workspace.workspaceFolders || []).map(
		(f) => f.uri.fsPath
	);
	const status = {
		active: true,
		port: cfg.port,
		version: "2.0.0",
		uptime: Math.floor((Date.now() - startTime) / 1000),
		workspaceFolders: folders,
		autoAccept: autoAcceptEnabled,
	};
	sendJson(res, 200, status);
}

async function handleModels(res: http.ServerResponse): Promise<void> {
	try {
		const models = await vscode.lm.selectChatModels({});
		sendJson(
			res,
			200,
			models.map((m) => ({
				id: m.id,
				family: m.family,
				vendor: m.vendor,
				version: m.version,
				maxInputTokens: m.maxInputTokens,
			}))
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		sendJson(res, 500, { error: msg });
	}
}

// ─── Chat / LLM ──────────────────────────────────────────────────────────────

async function handleChat(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body) {
		return;
	}

	let chatMessages: ChatMessage[];
	if (body.messages && body.messages.length > 0) {
		chatMessages = body.messages;
	} else if (body.message) {
		chatMessages = [{ role: "user", content: body.message }];
	} else {
		sendJson(res, 400, { error: 'Provide "message" or "messages"' });
		return;
	}

	const cfg = getConfig();
	const model = await pickModel(body.model || cfg.defaultModel || undefined);
	if (!model) {
		sendJson(res, 503, {
			error:
				"No language models available. Make sure GitHub Copilot is active.",
		});
		return;
	}

	const lmMessages = buildMessages(chatMessages, body.systemPrompt);
	log(
		`Chat → model=${model.id}, msgs=${lmMessages.length}, stream=${!!body.stream}`
	);

	try {
		const response = await model.sendRequest(lmMessages, {});
		if (body.stream) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			for await (const chunk of response.text) {
				res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
			}
			res.write(`data: [DONE]\n\n`);
			res.end();
		} else {
			let fullText = "";
			for await (const chunk of response.text) {
				fullText += chunk;
			}
			sendJson(res, 200, { response: fullText, model: model.id });
		}
	} catch (e) {
		if (e instanceof vscode.LanguageModelError) {
			sendJson(res, 502, { error: e.message, code: e.code });
		} else {
			sendJson(res, 500, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

async function handleCompletions(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body) {
		return;
	}

	if (!body.messages || body.messages.length === 0) {
		sendJson(res, 400, { error: '"messages" array is required' });
		return;
	}

	let systemPrompt: string | undefined;
	const chatMsgs: ChatMessage[] = [];
	for (const m of body.messages) {
		if (m.role === "system") {
			systemPrompt = (systemPrompt || "") + m.content + "\n";
		} else {
			chatMsgs.push({
				role: m.role === "assistant" ? "assistant" : "user",
				content: m.content,
			});
		}
	}

	const cfg = getConfig();
	const model = await pickModel(body.model || cfg.defaultModel || undefined);
	if (!model) {
		sendJson(res, 503, { error: "No language models available" });
		return;
	}

	const lmMessages = buildMessages(chatMsgs, systemPrompt?.trim());
	try {
		const response = await model.sendRequest(lmMessages, {});
		const id = `chatcmpl-${Date.now()}`;

		if (body.stream) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			for await (const chunk of response.text) {
				res.write(
					`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: model.id,
						choices: [
							{
								index: 0,
								delta: { content: chunk },
								finish_reason: null,
							},
						],
					})}\n\n`
				);
			}
			res.write(
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: model.id,
					choices: [
						{ index: 0, delta: {}, finish_reason: "stop" },
					],
				})}\n\n`
			);
			res.write(`data: [DONE]\n\n`);
			res.end();
		} else {
			let fullText = "";
			for await (const chunk of response.text) {
				fullText += chunk;
			}
			sendJson(res, 200, {
				id,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: model.id,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: fullText },
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				},
			});
		}
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ─── Workspace Management ────────────────────────────────────────────────────

async function handleWorkspaceFolders(
	res: http.ServerResponse
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders || [];
	sendJson(res, 200, {
		folders: folders.map((f) => ({
			name: f.name,
			path: f.uri.fsPath,
			index: f.index,
		})),
	});
}

async function handleOpenFolder(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body) {
		return;
	}
	if (!body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}
	if (!fs.existsSync(body.path) || !fs.statSync(body.path).isDirectory()) {
		sendJson(res, 404, {
			error: `Not a valid directory: ${body.path}`,
		});
		return;
	}

	const uri = vscode.Uri.file(body.path);

	// Mark as trusted to avoid the trust dialog
	await vscode.workspace
		.getConfiguration("security.workspace")
		.update("trust.enabled", false, vscode.ConfigurationTarget.Global)
		.then(
			() => {},
			() => {}
		);

	if (body.newWindow) {
		await vscode.commands.executeCommand("vscode.openFolder", uri, {
			forceNewWindow: true,
		});
		sendJson(res, 200, {
			ok: true,
			action: "opened_new_window",
			path: body.path,
		});
	} else {
		await vscode.commands.executeCommand("vscode.openFolder", uri, {
			forceNewWindow: false,
		});
		sendJson(res, 200, {
			ok: true,
			action: "opened_current_window",
			path: body.path,
		});
	}
}

async function handleAddFolder(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}
	if (!fs.existsSync(body.path) || !fs.statSync(body.path).isDirectory()) {
		sendJson(res, 404, {
			error: `Not a valid directory: ${body.path}`,
		});
		return;
	}

	const uri = vscode.Uri.file(body.path);
	const current = vscode.workspace.workspaceFolders || [];
	if (current.find((f) => f.uri.fsPath === uri.fsPath)) {
		sendJson(res, 200, {
			ok: true,
			action: "already_present",
			path: body.path,
		});
		return;
	}

	const success = vscode.workspace.updateWorkspaceFolders(
		current.length,
		0,
		{ uri }
	);
	sendJson(res, success ? 200 : 500, {
		ok: success,
		action: success ? "added" : "failed",
		path: body.path,
	});
}

async function handleRemoveFolder(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}

	const current = vscode.workspace.workspaceFolders || [];
	const target = current.find(
		(f) => f.uri.fsPath === vscode.Uri.file(body.path).fsPath
	);
	if (!target) {
		sendJson(res, 404, {
			error: `Not in workspace: ${body.path}`,
		});
		return;
	}

	const success = vscode.workspace.updateWorkspaceFolders(target.index, 1);
	sendJson(res, success ? 200 : 500, {
		ok: success,
		action: success ? "removed" : "failed",
		path: body.path,
	});
}

// ─── File Operations ─────────────────────────────────────────────────────────

async function handleListFiles(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const folderPath = url.searchParams.get("path");
	const pattern = url.searchParams.get("pattern") || "**/*";
	const maxResults = parseInt(url.searchParams.get("max") || "500", 10);

	try {
		let glob: string | vscode.RelativePattern = pattern;
		if (folderPath) {
			glob = new vscode.RelativePattern(
				vscode.Uri.file(folderPath),
				pattern
			);
		}
		const files = await vscode.workspace.findFiles(
			glob,
			"**/node_modules/**",
			maxResults
		);
		sendJson(res, 200, {
			count: files.length,
			files: files.map((f) => ({
				path: f.fsPath,
				name: path.basename(f.fsPath),
				ext: path.extname(f.fsPath),
			})),
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleReadFile(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}
	if (!fs.existsSync(body.path)) {
		sendJson(res, 404, { error: `Not found: ${body.path}` });
		return;
	}

	try {
		const content = fs.readFileSync(body.path, "utf-8");
		const lines = content.split("\n");
		const start = (body.startLine || 1) - 1;
		const end = body.endLine || lines.length;
		sendJson(res, 200, {
			path: body.path,
			totalLines: lines.length,
			startLine: start + 1,
			endLine: Math.min(end, lines.length),
			content: lines.slice(start, end).join("\n"),
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleWriteFile(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path || body.content === undefined) {
		sendJson(res, 400, { error: '"path" and "content" required' });
		return;
	}

	try {
		if (body.createDirs) {
			fs.mkdirSync(path.dirname(body.path), { recursive: true });
		}
		if (body.append) {
			fs.appendFileSync(body.path, body.content, "utf-8");
		} else {
			fs.writeFileSync(body.path, body.content, "utf-8");
		}
		sendJson(res, 200, { ok: true, path: body.path });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleDeleteFile(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}
	if (!fs.existsSync(body.path)) {
		sendJson(res, 404, { error: `Not found: ${body.path}` });
		return;
	}

	try {
		const stat = fs.statSync(body.path);
		if (stat.isDirectory()) {
			fs.rmSync(body.path, { recursive: !!body.recursive, force: true });
		} else {
			fs.unlinkSync(body.path);
		}
		sendJson(res, 200, { ok: true, deleted: body.path });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleMkdir(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}

	try {
		fs.mkdirSync(body.path, { recursive: true });
		sendJson(res, 200, { ok: true, path: body.path });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleRename(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.from || !body.to) {
		sendJson(res, 400, { error: '"from" and "to" are required' });
		return;
	}

	try {
		fs.renameSync(body.from, body.to);
		sendJson(res, 200, { ok: true, from: body.from, to: body.to });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ─── Editor Operations ──────────────────────────────────────────────────────

async function handleOpenFile(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path) {
		sendJson(res, 400, { error: '"path" is required' });
		return;
	}

	try {
		const uri = vscode.Uri.file(body.path);
		const doc = await vscode.workspace.openTextDocument(uri);
		const opts: vscode.TextDocumentShowOptions = {
			preview: body.preview ?? false,
		};
		if (body.line) {
			const pos = new vscode.Position(
				(body.line || 1) - 1,
				(body.column || 1) - 1
			);
			opts.selection = new vscode.Range(pos, pos);
		}
		await vscode.window.showTextDocument(doc, opts);
		sendJson(res, 200, {
			ok: true,
			path: body.path,
			lines: doc.lineCount,
			language: doc.languageId,
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleGetActiveEditor(
	res: http.ServerResponse
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		sendJson(res, 200, { active: false });
		return;
	}
	const doc = editor.document;
	sendJson(res, 200, {
		active: true,
		path: doc.uri.fsPath,
		language: doc.languageId,
		lineCount: doc.lineCount,
		isDirty: doc.isDirty,
		selection: {
			startLine: editor.selection.start.line + 1,
			startCol: editor.selection.start.character + 1,
			endLine: editor.selection.end.line + 1,
			endCol: editor.selection.end.character + 1,
		},
	});
}

async function handleEditFile(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.path || !body.edits) {
		sendJson(res, 400, { error: '"path" and "edits" required' });
		return;
	}

	try {
		const uri = vscode.Uri.file(body.path);
		const doc = await vscode.workspace.openTextDocument(uri);
		const wsEdit = new vscode.WorkspaceEdit();

		for (const edit of body.edits) {
			const startPos = new vscode.Position(edit.startLine - 1, 0);
			const endPos =
				edit.endLine <= doc.lineCount
					? new vscode.Position(
							edit.endLine - 1,
							doc.lineAt(edit.endLine - 1).text.length
						)
					: new vscode.Position(
							doc.lineCount - 1,
							doc.lineAt(doc.lineCount - 1).text.length
						);
			wsEdit.replace(
				uri,
				new vscode.Range(startPos, endPos),
				edit.newText
			);
		}
		const success = await vscode.workspace.applyEdit(wsEdit);
		if (success) {
			await doc.save();
		}
		sendJson(res, 200, { ok: success, editsApplied: body.edits.length });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleSearchReplace(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (
		!body ||
		!body.path ||
		body.search === undefined ||
		body.replace === undefined
	) {
		sendJson(res, 400, {
			error: '"path", "search", and "replace" are required',
		});
		return;
	}

	try {
		let content = fs.readFileSync(body.path, "utf-8");
		let count = 0;
		if (body.all) {
			const parts = content.split(body.search);
			count = parts.length - 1;
			content = parts.join(body.replace);
		} else {
			if (content.includes(body.search)) {
				content = content.replace(body.search, body.replace);
				count = 1;
			}
		}
		if (count > 0) {
			fs.writeFileSync(body.path, content, "utf-8");
		}
		sendJson(res, 200, {
			ok: true,
			replacements: count,
			path: body.path,
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleDiff(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.left || !body.right) {
		sendJson(res, 400, { error: '"left" and "right" required' });
		return;
	}

	try {
		await vscode.commands.executeCommand(
			"vscode.diff",
			vscode.Uri.file(body.left),
			vscode.Uri.file(body.right),
			body.title ||
				`${path.basename(body.left)} ↔ ${path.basename(body.right)}`
		);
		sendJson(res, 200, { ok: true });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleSaveAll(res: http.ServerResponse): Promise<void> {
	await vscode.workspace.saveAll();
	sendJson(res, 200, { ok: true, action: "all_files_saved" });
}

async function handleCloseEditor(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (body?.all) {
		await vscode.commands.executeCommand(
			"workbench.action.closeAllEditors"
		);
	} else {
		await vscode.commands.executeCommand(
			"workbench.action.closeActiveEditor"
		);
	}
	sendJson(res, 200, { ok: true });
}

// ─── Terminal Execution ──────────────────────────────────────────────────────

async function handleTerminalExec(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.command) {
		sendJson(res, 400, { error: '"command" is required' });
		return;
	}

	const timeout = body.timeout ?? 30000;
	try {
		const result = await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve) => {
			const opts: child_process.ExecOptions = {
				cwd:
					body.cwd ||
					vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				timeout,
				maxBuffer: 1024 * 1024 * 10, // 10MB
				windowsHide: true,
			};
			if (body.shell) {
				opts.shell = body.shell;
			}
			child_process.exec(
				body.command,
				opts,
				(error, stdout, stderr) => {
					resolve({
						stdout: stdout?.toString() || "",
						stderr: stderr?.toString() || "",
						exitCode: error ? (error as NodeJS.ErrnoException).code as unknown as number ?? 1 : 0,
					});
				}
			);
		});
		sendJson(res, 200, {
			ok: result.exitCode === 0,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleTerminalCreate(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	const id = `term_${++terminalIdCounter}`;
	const terminal = vscode.window.createTerminal({
		name: body?.name || `Bridge-${id}`,
		cwd:
			body?.cwd ||
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	});
	managedTerminals.set(id, terminal);
	terminal.show();
	sendJson(res, 200, { ok: true, terminalId: id, name: terminal.name });
}

async function handleTerminalSend(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.text) {
		sendJson(res, 400, { error: '"text" is required' });
		return;
	}

	let terminal: vscode.Terminal | undefined;
	if (body.terminalId) {
		terminal = managedTerminals.get(body.terminalId);
	}
	if (!terminal) {
		terminal = vscode.window.activeTerminal;
	}
	if (!terminal) {
		terminal = vscode.window.createTerminal("Bridge");
		const id = `term_${++terminalIdCounter}`;
		managedTerminals.set(id, terminal);
	}
	terminal.show();
	terminal.sendText(body.text, body.newline ?? true);
	sendJson(res, 200, { ok: true });
}

async function handleTerminalList(res: http.ServerResponse): Promise<void> {
	const terminals = vscode.window.terminals.map((t, i) => ({
		index: i,
		name: t.name,
		managedId:
			[...managedTerminals.entries()].find(([, v]) => v === t)?.[0] ||
			null,
	}));
	sendJson(res, 200, { terminals });
}

// ─── Git Operations ──────────────────────────────────────────────────────────

async function handleGit(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.command) {
		sendJson(res, 400, {
			error: '"command" is required (e.g. "status", "add .", "commit -m msg", "push")',
		});
		return;
	}

	const cwd =
		body.cwd ||
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
		".";
	try {
		const result = await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve) => {
			child_process.exec(
				`git ${body.command}`,
				{
					cwd,
					timeout: 30000,
					maxBuffer: 1024 * 1024 * 5,
				},
				(error, stdout, stderr) => {
					resolve({
						stdout: stdout?.toString() || "",
						stderr: stderr?.toString() || "",
						exitCode: error
							? (error as NodeJS.ErrnoException).code as unknown as number ?? 1
							: 0,
					});
				}
			);
		});
		sendJson(res, 200, {
			ok: result.exitCode === 0,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ─── Copilot Chat Interaction ────────────────────────────────────────────────

async function handleCopilotChat(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body) {
		return;
	}

	try {
		if (body.action === "open") {
			await vscode.commands.executeCommand(
				"workbench.action.chat.open"
			);
			sendJson(res, 200, { ok: true, action: "chat_opened" });
		} else if (body.action === "clear") {
			await vscode.commands.executeCommand(
				"workbench.action.chat.clear"
			);
			sendJson(res, 200, { ok: true, action: "chat_cleared" });
		} else if (body.action === "accept") {
			await acceptAllCopilotEdits();
			sendJson(res, 200, { ok: true, action: "edits_accepted" });
		} else if (body.action === "discard") {
			await vscode.commands.executeCommand(
				"chatEditor.action.reject"
			);
			sendJson(res, 200, { ok: true, action: "edits_discarded" });
		} else if (body.message) {
			await vscode.commands.executeCommand(
				"workbench.action.chat.open"
			);
			await new Promise((r) => setTimeout(r, 300));
			await vscode.commands.executeCommand(
				"workbench.action.chat.sendToNewChat",
				body.message
			);
			sendJson(res, 200, {
				ok: true,
				action: "message_sent",
				message: body.message,
			});
		} else {
			sendJson(res, 400, {
				error: 'Provide "message" or "action" (open|clear|accept|discard)',
			});
		}
	} catch (e) {
		log(
			`Copilot chat action error: ${e instanceof Error ? e.message : String(e)}`
		);
		sendJson(res, 200, {
			ok: true,
			action: body.action || "message_sent",
			warning:
				"Command may not be available in your VS Code version",
		});
	}
}

async function acceptAllCopilotEdits(): Promise<void> {
	const acceptCommands = [
		"chatEditor.action.accept",
		"inlineChat.accept",
		"editor.action.inlineSuggest.commit",
		"workbench.action.chat.acceptEdit",
	];
	for (const cmd of acceptCommands) {
		try {
			await vscode.commands.executeCommand(cmd);
		} catch {
			// Command not available, try next
		}
	}
}

// ─── Auto-Accept / Trust / Allow ─────────────────────────────────────────────

async function handleAutoAccept(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (body && body.enabled !== undefined) {
		autoAcceptEnabled = body.enabled;
	}
	sendJson(res, 200, {
		autoAccept: autoAcceptEnabled,
		description:
			"When enabled, the extension auto-configures VS Code settings to minimize permission dialogs.",
	});
}

async function handleTrustWorkspace(
	res: http.ServerResponse
): Promise<void> {
	try {
		await vscode.commands.executeCommand("workbench.trust.manage");
		const config = vscode.workspace.getConfiguration(
			"security.workspace.trust"
		);
		await config
			.update("enabled", false, vscode.ConfigurationTarget.Global)
			.then(
				() => {},
				() => {}
			);
		sendJson(res, 200, { ok: true, action: "workspace_trusted" });
	} catch {
		sendJson(res, 200, {
			ok: true,
			action: "trust_attempted",
			note: "Manual trust may be needed",
		});
	}
}

async function handleConfigureForVibeCoding(
	res: http.ServerResponse
): Promise<void> {
	const settings: [string, unknown, string][] = [
		// Trust
		[
			"security.workspace.trust.enabled",
			false,
			"Disable workspace trust dialogs",
		],
		// Copilot
		[
			"github.copilot.editor.enableAutoCompletions",
			true,
			"Enable Copilot completions",
		],
		[
			"github.copilot.enable",
			{ "*": true },
			"Enable Copilot for all languages",
		],
		// Editor
		["editor.autoSave", "afterDelay", "Auto-save files"],
		["editor.autoSaveDelay", 1000, "Save after 1 second"],
		["editor.formatOnSave", true, "Format on save"],
		["files.autoSave", "afterDelay", "Auto-save files"],
		// Terminal
		[
			"terminal.integrated.enablePersistentSessions",
			true,
			"Persistent terminal sessions",
		],
		// Git
		["git.autofetch", true, "Auto-fetch git"],
		["git.confirmSync", false, "Don't confirm sync"],
		["git.enableSmartCommit", true, "Smart commit"],
		// Extensions — don't prompt
		[
			"extensions.ignoreRecommendations",
			true,
			"Ignore extension recommendations",
		],
	];

	const applied: string[] = [];
	for (const [key, value, desc] of settings) {
		try {
			const parts = key.split(".");
			const section = parts.slice(0, -1).join(".");
			const prop = parts[parts.length - 1];
			await vscode.workspace
				.getConfiguration(section)
				.update(prop, value, vscode.ConfigurationTarget.Global);
			applied.push(desc);
		} catch {
			// Some settings may not exist
		}
	}
	sendJson(res, 200, {
		ok: true,
		appliedSettings: applied,
		count: applied.length,
	});
}

// ─── VS Code Command Proxy ──────────────────────────────────────────────────

async function handleSay(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.message) {
		sendJson(res, 400, { error: '"message" is required' });
		return;
	}

	const mode = body.mode || "chat"; // chat | notify | log | all
	const results: string[] = [];

	try {
		// 1) Send to Copilot Chat input
		if (mode === "chat" || mode === "all") {
			try {
				await vscode.commands.executeCommand(
					"workbench.action.chat.open",
					{ query: body.message }
				);
				results.push("chat_input_filled");
			} catch {
				try {
					await vscode.commands.executeCommand(
						"workbench.action.chat.open"
					);
					await new Promise((r) => setTimeout(r, 300));
					await vscode.commands.executeCommand(
						"workbench.action.chat.sendToNewChat",
						body.message
					);
					results.push("chat_sent_to_new");
				} catch {
					results.push("chat_fallback_failed");
				}
			}
		}

		// 2) Show as VS Code notification
		if (mode === "notify" || mode === "all") {
			vscode.window.showInformationMessage(`[Bot] ${body.message}`);
			results.push("notification_shown");
		}

		// 3) Log to visible output channel
		if (mode === "log" || mode === "all") {
			output.show(true);
			output.appendLine(`[BOT] ${body.message}`);
			results.push("output_logged");
		}

		// 4) Always push to message queue for polling via GET /messages
		messageQueue.push({
			message: body.message,
			mode,
			timestamp: new Date().toISOString(),
			id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		});

		// Keep queue bounded (max 100 messages)
		while (messageQueue.length > 100) {
			messageQueue.shift();
		}

		sendJson(res, 200, { ok: true, mode, results });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

async function handleRunCommand(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.command) {
		sendJson(res, 400, { error: '"command" is required' });
		return;
	}

	try {
		const result = await vscode.commands.executeCommand(
			body.command,
			...(body.args || [])
		);
		sendJson(res, 200, {
			ok: true,
			command: body.command,
			result: result ?? null,
		});
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
			command: body.command,
		});
	}
}

// ─── Messages Queue (Polling) ────────────────────────────────────────────────

async function handleMessages(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const since = url.searchParams.get("since"); // ISO timestamp filter
	const peek = url.searchParams.get("peek") === "true"; // don't clear if true
	const filter = url.searchParams.get("filter"); // substring match

	let messages: QueuedMessage[];
	if (since) {
		messages = messageQueue.filter((m) => m.timestamp > since);
	} else {
		messages = [...messageQueue];
	}
	if (filter) {
		messages = messages.filter((m) => m.message.includes(filter));
	}

	// By default, drain the queue (remove returned messages) unless peek=true
	if (!peek && messages.length > 0) {
		const returnedIds = new Set(messages.map((m) => m.id));
		for (let i = messageQueue.length - 1; i >= 0; i--) {
			if (returnedIds.has(messageQueue[i].id)) {
				messageQueue.splice(i, 1);
			}
		}
	}

	sendJson(res, 200, { count: messages.length, messages });
}

// ─── Diagnostics / Errors ────────────────────────────────────────────────────

async function handleDiagnostics(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const filePath = url.searchParams.get("path");

	const allDiags: {
		path: string;
		diagnostics: {
			line: number;
			col: number;
			message: string;
			severity: string;
			source: string;
		}[];
	}[] = [];

	const entries: [vscode.Uri, vscode.Diagnostic[]][] = filePath
		? [
				[
					vscode.Uri.file(filePath),
					vscode.languages.getDiagnostics(
						vscode.Uri.file(filePath)
					),
				],
			]
		: vscode.languages.getDiagnostics();

	for (const [uri, diags] of entries) {
		if (diags.length > 0) {
			allDiags.push({
				path: uri.fsPath,
				diagnostics: diags.map((d) => ({
					line: d.range.start.line + 1,
					col: d.range.start.character + 1,
					message: d.message,
					severity: vscode.DiagnosticSeverity[d.severity],
					source: d.source || "",
				})),
			});
		}
	}

	sendJson(res, 200, {
		totalFiles: allDiags.length,
		errors: allDiags,
	});
}

// ─── Search in files ─────────────────────────────────────────────────────────

async function handleGrep(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const raw = await readBody(req);
	const body = parseBody(raw, res);
	if (!body || !body.pattern) {
		sendJson(res, 400, { error: '"pattern" is required' });
		return;
	}

	const cwd =
		body.path ||
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
		".";
	try {
		const max = body.maxResults || 50;
		const result = await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve) => {
			const cmd =
				process.platform === "win32"
					? `findstr /s /n /i /c:"${body.pattern}" *`
					: `grep -rn --include="*" -m ${max} "${body.pattern}" .`;
			child_process.exec(
				cmd,
				{
					cwd,
					timeout: 15000,
					maxBuffer: 1024 * 1024 * 5,
				},
				(error, stdout, stderr) => {
					resolve({
						stdout: stdout?.toString() || "",
						stderr: stderr?.toString() || "",
						exitCode: error
							? (error as NodeJS.ErrnoException).code as unknown as number ?? 1
							: 0,
					});
				}
			);
		});
		const lines = result.stdout
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, body.maxResults || 50);
		sendJson(res, 200, { count: lines.length, matches: lines });
	} catch (e) {
		sendJson(res, 500, {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SERVER LIFECYCLE ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function startServer(port: number, apiKey: string): void {
	if (server) {
		log("Server already running");
		return;
	}

	server = http.createServer(async (req, res) => {
		setCors(res);

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (!checkAuth(req, apiKey)) {
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}

		const url = new URL(
			req.url || "/",
			`http://127.0.0.1:${port}`
		);
		const p = url.pathname;

		try {
			// ── Core ──
			if (p === "/status" && req.method === "GET") {
				await handleStatus(res);
			} else if (p === "/models" && req.method === "GET") {
				await handleModels(res);
			} else if (p === "/chat" && req.method === "POST") {
				await handleChat(req, res);
			} else if (
				p === "/v1/chat/completions" &&
				req.method === "POST"
			) {
				await handleCompletions(req, res);
			}
			// ── Workspace ──
			else if (
				p === "/workspace/folders" &&
				req.method === "GET"
			) {
				await handleWorkspaceFolders(res);
			} else if (
				p === "/workspace/open" &&
				req.method === "POST"
			) {
				await handleOpenFolder(req, res);
			} else if (
				p === "/workspace/add" &&
				req.method === "POST"
			) {
				await handleAddFolder(req, res);
			} else if (
				p === "/workspace/remove" &&
				req.method === "POST"
			) {
				await handleRemoveFolder(req, res);
			}
			// ── Files ──
			else if (p === "/files/list" && req.method === "GET") {
				await handleListFiles(req, res);
			} else if (p === "/files/read" && req.method === "POST") {
				await handleReadFile(req, res);
			} else if (
				p === "/files/write" &&
				req.method === "POST"
			) {
				await handleWriteFile(req, res);
			} else if (
				p === "/files/delete" &&
				req.method === "POST"
			) {
				await handleDeleteFile(req, res);
			} else if (
				p === "/files/mkdir" &&
				req.method === "POST"
			) {
				await handleMkdir(req, res);
			} else if (
				p === "/files/rename" &&
				req.method === "POST"
			) {
				await handleRename(req, res);
			} else if (
				p === "/files/search" &&
				req.method === "POST"
			) {
				await handleGrep(req, res);
			}
			// ── Editor ──
			else if (
				p === "/editor/open" &&
				req.method === "POST"
			) {
				await handleOpenFile(req, res);
			} else if (
				p === "/editor/active" &&
				req.method === "GET"
			) {
				await handleGetActiveEditor(res);
			} else if (
				p === "/editor/edit" &&
				req.method === "POST"
			) {
				await handleEditFile(req, res);
			} else if (
				p === "/editor/replace" &&
				req.method === "POST"
			) {
				await handleSearchReplace(req, res);
			} else if (
				p === "/editor/diff" &&
				req.method === "POST"
			) {
				await handleDiff(req, res);
			} else if (
				p === "/editor/save-all" &&
				req.method === "POST"
			) {
				await handleSaveAll(res);
			} else if (
				p === "/editor/close" &&
				req.method === "POST"
			) {
				await handleCloseEditor(req, res);
			}
			// ── Terminal ──
			else if (
				p === "/terminal/exec" &&
				req.method === "POST"
			) {
				await handleTerminalExec(req, res);
			} else if (
				p === "/terminal/create" &&
				req.method === "POST"
			) {
				await handleTerminalCreate(req, res);
			} else if (
				p === "/terminal/send" &&
				req.method === "POST"
			) {
				await handleTerminalSend(req, res);
			} else if (
				p === "/terminal/list" &&
				req.method === "GET"
			) {
				await handleTerminalList(res);
			}
			// ── Git ──
			else if (p === "/git" && req.method === "POST") {
				await handleGit(req, res);
			}
			// ── Copilot ──
			else if (p === "/copilot" && req.method === "POST") {
				await handleCopilotChat(req, res);
			}
			// ── Diagnostics ──
			else if (
				p === "/diagnostics" &&
				req.method === "GET"
			) {
				await handleDiagnostics(req, res);
			}
			// ── Auto-accept / Trust ──
			else if (
				p === "/auto-accept" &&
				req.method === "POST"
			) {
				await handleAutoAccept(req, res);
			} else if (p === "/trust" && req.method === "POST") {
				await handleTrustWorkspace(res);
			} else if (
				p === "/setup-vibe-coding" &&
				req.method === "POST"
			) {
				await handleConfigureForVibeCoding(res);
			}
			// ── VS Code command proxy ──
			else if (p === "/command" && req.method === "POST") {
				await handleRunCommand(req, res);
			}
			// ── Say / Visible message ──
			else if (p === "/say" && req.method === "POST") {
				await handleSay(req, res);
			}
			// ── Messages Queue (Polling) ──
			else if (p === "/messages" && req.method === "GET") {
				await handleMessages(req, res);
			}
			// ── 404 ──
			else {
				sendJson(res, 404, {
					error: "Not found. GET /endpoints for the full list.",
				});
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`Unhandled error: ${msg}`);
			if (!res.headersSent) {
				sendJson(res, 500, { error: "Internal server error" });
			}
		}
	});

	server.listen(port, "127.0.0.1", () => {
		startTime = Date.now();
		log(`Bridge v2 listening on http://127.0.0.1:${port}`);
		vscode.window.showInformationMessage(
			`Kunilingus Bridge v2 active on port ${port}`
		);
		updateStatusBar(true, port);

		// Auto-configure for vibe coding on start
		if (autoAcceptEnabled) {
			handleConfigureForVibeCoding({
				writeHead: () => {},
				end: () => {},
				setHeader: () => {},
			} as unknown as http.ServerResponse);
		}
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			vscode.window.showErrorMessage(
				`Port ${port} in use. Change in settings.`
			);
		} else {
			vscode.window.showErrorMessage(
				`Bridge error: ${err.message}`
			);
		}
		log(`Server error: ${err.message}`);
		server = undefined;
		updateStatusBar(false);
	});
}

function stopServer(): void {
	if (server) {
		server.close();
		server = undefined;
		log("Bridge server stopped");
		vscode.window.showInformationMessage("Kunilingus Bridge stopped");
		updateStatusBar(false);
	}
}

function updateStatusBar(active: boolean, port?: number): void {
	if (active) {
		statusBarItem.text = `$(radio-tower) Bridge :${port}`;
		statusBarItem.tooltip = `Kunilingus Bridge v2 active on port ${port}`;
		statusBarItem.color = new vscode.ThemeColor(
			"statusBarItem.warningForeground"
		);
	} else {
		statusBarItem.text = `$(circle-slash) Bridge OFF`;
		statusBarItem.tooltip = "Kunilingus Bridge is not running";
		statusBarItem.color = undefined;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ACTIVATION ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
	log("Extension activating...");

	// Status bar
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.command = "kunilingus-bridge.status";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("kunilingus-bridge.start", () => {
			const cfg = getConfig();
			startServer(cfg.port, cfg.apiKey);
		}),
		vscode.commands.registerCommand("kunilingus-bridge.stop", () =>
			stopServer()
		),
		vscode.commands.registerCommand(
			"kunilingus-bridge.status",
			async () => {
				if (server) {
					const cfg = getConfig();
					const uptime = Math.floor(
						(Date.now() - startTime) / 1000
					);
					const models = await vscode.lm.selectChatModels({});
					vscode.window.showInformationMessage(
						`Bridge v2: ON | Port: ${cfg.port} | Uptime: ${uptime}s | Models: ${models.length}`
					);
				} else {
					const action =
						await vscode.window.showInformationMessage(
							"Bridge is not running",
							"Start"
						);
					if (action === "Start") {
						vscode.commands.executeCommand(
							"kunilingus-bridge.start"
						);
					}
				}
			}
		)
	);

	// Auto-start
	const cfg = getConfig();
	if (cfg.autoStart) {
		startServer(cfg.port, cfg.apiKey);
	} else {
		updateStatusBar(false);
	}

	// React to config changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("kunilingus-bridge")) {
				const wasRunning = !!server;
				if (wasRunning) {
					stopServer();
					const newCfg = getConfig();
					startServer(newCfg.port, newCfg.apiKey);
				}
			}
		})
	);

	// Clean up dead terminals
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((t) => {
			for (const [id, term] of managedTerminals.entries()) {
				if (term === t) {
					managedTerminals.delete(id);
					break;
				}
			}
		})
	);

	log("Extension v2 activated");
}

export function deactivate(): void {
	stopServer();
	output.dispose();
}
