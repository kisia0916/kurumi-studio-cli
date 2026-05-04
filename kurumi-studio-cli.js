#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const AUTH_COOKIE_NAME = "kurumi_session";
const DEFAULT_BASE_URL = "https://kurumi-studio.kigyokusai.com";
const DEFAULT_SESSION_FILE = path.join(os.homedir(), ".kurumi-studio-cli", "session.json");

class CliError extends Error {
  constructor(message, statusCode = 1, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }

    const key = trimmed;
    const nextToken = argv[i + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      flags[key] = nextToken;
      i += 1;
      continue;
    }

    flags[key] = true;
  }

  return { flags, positionals };
}

function parseBoolean(value, keyName) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    throw new CliError(`--${keyName} must be true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new CliError(`--${keyName} must be true or false`);
}

function parseOptionalCoordinate(value, keyName) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${keyName} must be a number`);
  }
  const rounded = Math.round(parsed);
  if (rounded < 0 || rounded > 100) {
    throw new CliError(`--${keyName} must be between 0 and 100`);
  }
  return rounded;
}

function parsePlaceType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "FOOD" || normalized === "NONE") {
    return normalized;
  }
  throw new CliError("--place-type must be FOOD or NONE");
}

function parseEnum(value, keyName, allowedValues, defaultValue) {
  if (value === undefined || value === null || value === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new CliError(`--${keyName} is required`);
  }
  const normalized = String(value).trim().toUpperCase();
  if (!allowedValues.includes(normalized)) {
    throw new CliError(`--${keyName} must be one of ${allowedValues.join(", ")}`);
  }
  return normalized;
}

function parseNonNegativeInteger(value, keyName, defaultValue) {
  if (value === undefined || value === null || value === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new CliError(`--${keyName} is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${keyName} must be a number`);
  }
  return Math.max(0, Math.round(parsed));
}

function parseStringArray(value, keyName, defaultValue = []) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);

  const raw = String(value).trim();
  if (!raw) return defaultValue;

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new CliError(`--${keyName} JSON must be an array`);
      }
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`--${keyName} must be comma-separated or JSON array`);
    }
  }

  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeBaseUrl(input) {
  const value = (input || DEFAULT_BASE_URL).trim();
  if (!value) {
    throw new CliError("base URL is empty");
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveSessionFile(input) {
  const value = (input || DEFAULT_SESSION_FILE).trim();
  return path.resolve(value);
}

function ensureParentDir(filePath) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
}

function readSessionCookie(sessionFilePath) {
  try {
    if (!fs.existsSync(sessionFilePath)) {
      return null;
    }
    const raw = fs.readFileSync(sessionFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.cookie !== "string" || parsed.cookie.trim() === "") {
      return null;
    }
    return parsed.cookie;
  } catch {
    return null;
  }
}

function writeSessionCookie(sessionFilePath, cookie, baseUrl) {
  ensureParentDir(sessionFilePath);
  const payload = {
    cookie,
    baseUrl,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function clearSessionCookie(sessionFilePath) {
  if (fs.existsSync(sessionFilePath)) {
    fs.unlinkSync(sessionFilePath);
  }
}

function extractSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const fallback = headers.get("set-cookie");
  return fallback ? [fallback] : [];
}

function extractCookieFromSetCookie(headers, cookieName) {
  const values = extractSetCookieValues(headers);
  for (const headerValue of values) {
    const sections = headerValue.split(";");
    const first = sections[0] || "";
    const eqIndex = first.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = first.slice(0, eqIndex).trim();
    const value = first.slice(eqIndex + 1).trim();
    if (key === cookieName && value) {
      return value;
    }
  }
  return null;
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  if (!text) return null;
  return { text };
}

async function requestApi(context, options) {
  const method = (options.method || "GET").toUpperCase();
  const endpointPath = options.path || "/";
  const body = options.body;
  const url = `${context.baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;

  const headers = {
    Accept: "application/json",
  };

  const sessionCookie = readSessionCookie(context.sessionFile);
  if (sessionCookie) {
    headers.Cookie = `${AUTH_COOKIE_NAME}=${sessionCookie}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const newCookie = extractCookieFromSetCookie(response.headers, AUTH_COOKIE_NAME);
  if (newCookie) {
    writeSessionCookie(context.sessionFile, newCookie, context.baseUrl);
  }

  const data = await readResponseBody(response);
  if (!response.ok) {
    const errorMessage =
      (data && typeof data === "object" && typeof data.error === "string" && data.error) ||
      `${method} ${endpointPath} failed with status ${response.status}`;
    throw new CliError(errorMessage, 1, {
      ok: false,
      status: response.status,
      method,
      path: endpointPath,
      data,
    });
  }

  return {
    ok: true,
    status: response.status,
    method,
    path: endpointPath,
    data,
  };
}

function requireValue(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`--${name} is required`);
  }
  return value.trim();
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printHelp() {
  const lines = [
    "kurumi-studio-cli",
    "",
    "Default base URL:",
    `  ${DEFAULT_BASE_URL}`,
    "",
    "Global options:",
    "  --base-url <url>        Override API base URL",
    "  --session-file <path>   Override auth session file path",
    "",
    "Commands:",
    "  auth login --name <name> --password <password>",
    "  auth me",
    "  auth logout",
    "  drafts list",
    "  drafts get --kind <project|food|stamp|event> --id <draftId>",
    "  drafts delete --kind <project|food|stamp|event> --id <draftId>",
    "  drafts approve --kind <project|food|stamp|event> --id <draftId> [--pin-x <0-100> --pin-y <0-100>]",
    "  project create --name <name> --description <text> --floor-id <id> --room-name <text> --project-genre <text> --team-name <text> --place-type <FOOD|NONE> [--picture <url>] [--building-id <id>] [--pin-x <0-100> --pin-y <0-100>] [--approve <true|false>]",
    "  food create --food-place-id <id> --name <name> [--category <MAIN|SUB|DESSERT>] [--price <number>] [--status <AVAILABLE|FEW|SOLDOUT>] [--allergens <a,b,c|json>] [--photo <url>] [--food-index <n>] [--approve <true|false>]",
    "  stamp create --title <title> --project-id <id> --quiz-data <text> --random-key <text> [--index <n>] [--approve <true|false>]",
    "  event create --title <title> --start-time <HH:mm> --end-time <HH:mm> --event-space-id <id> --event-date-id <id> [--project-id <id>] [--approve <true|false>]",
    "  site publication-current",
    "  site publication-set --published <true|false>",
    "  accounts list",
    "  accounts create --name <name> --password <password> --role <admin|editor>",
    "  accounts delete --id <accountId>",
    "  request --method <GET|POST|DELETE|PATCH|PUT> --path </api/...> [--body <json>]",
    "",
    "Examples:",
    "  node scripts/kurumi-studio-cli.js auth login --name admin --password secret",
    "  node scripts/kurumi-studio-cli.js drafts approve --kind project --id <draftId> --pin-x 50 --pin-y 40",
    "  node scripts/kurumi-studio-cli.js project create --name \"New Booth\" --description \"desc\" --floor-id <id> --room-name \"101\" --project-genre \"展示\" --team-name \"A組\" --place-type NONE --pin-x 20 --pin-y 80 --approve true",
    "  node scripts/kurumi-studio-cli.js food create --food-place-id <id> --name \"焼きそば\" --category MAIN --price 500 --status AVAILABLE --allergens \"wheat,egg\" --approve true",
    "  node scripts/kurumi-studio-cli.js stamp create --title \"1. クイズ\" --project-id <id> --quiz-data \"問題文\" --random-key \"ABC\" --index 1 --approve true",
    "  node scripts/kurumi-studio-cli.js event create --title \"開会式\" --start-time 09:00 --end-time 09:30 --event-space-id <id> --event-date-id <id> --approve true",
    "  node scripts/kurumi-studio-cli.js site publication-set --published false",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function getDraftRoutePrefix(kind) {
  const normalized = (kind || "").trim().toLowerCase();
  if (!normalized) {
    throw new CliError("--kind is required");
  }
  const supported = ["project", "food", "stamp", "event"];
  if (!supported.includes(normalized)) {
    throw new CliError("--kind must be one of project, food, stamp, event");
  }
  return `${normalized}_draft`;
}

async function run() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const { positionals, flags } = parsed;

  if (positionals.length === 0 || flags.help || flags.h) {
    printHelp();
    return;
  }

  const context = {
    baseUrl: normalizeBaseUrl(
      typeof flags["base-url"] === "string" ? flags["base-url"] : process.env.KURUMI_STUDIO_BASE_URL
    ),
    sessionFile: resolveSessionFile(
      typeof flags["session-file"] === "string" ? flags["session-file"] : process.env.KURUMI_STUDIO_SESSION_FILE
    ),
  };

  const [group, action] = positionals;

  if (group === "auth" && action === "login") {
    const name = requireValue(flags, "name");
    const password = requireValue(flags, "password");
    const result = await requestApi(context, {
      method: "POST",
      path: "/api/auth/login",
      body: { name, password },
    });
    printResult(result);
    return;
  }

  if (group === "auth" && action === "me") {
    const result = await requestApi(context, {
      method: "GET",
      path: "/api/auth/me",
    });
    printResult(result);
    return;
  }

  if (group === "auth" && action === "logout") {
    const result = await requestApi(context, {
      method: "POST",
      path: "/api/auth/logout",
      body: {},
    });
    clearSessionCookie(context.sessionFile);
    printResult(result);
    return;
  }

  if (group === "drafts" && action === "list") {
    const result = await requestApi(context, {
      method: "GET",
      path: "/api/drafts",
    });
    printResult(result);
    return;
  }

  if (group === "drafts" && action === "get") {
    const kind = getDraftRoutePrefix(flags.kind);
    const id = requireValue(flags, "id");
    const result = await requestApi(context, {
      method: "GET",
      path: `/api/${kind}/${encodeURIComponent(id)}`,
    });
    printResult(result);
    return;
  }

  if (group === "drafts" && action === "delete") {
    const kind = getDraftRoutePrefix(flags.kind);
    const id = requireValue(flags, "id");
    const result = await requestApi(context, {
      method: "DELETE",
      path: `/api/${kind}/${encodeURIComponent(id)}`,
    });
    printResult(result);
    return;
  }

  if (group === "drafts" && action === "approve") {
    const kind = getDraftRoutePrefix(flags.kind);
    const id = requireValue(flags, "id");
    const body = { draft_id: id };

    if (kind === "project_draft") {
      if (flags["pin-x"] !== undefined) body.pin_x = Number(flags["pin-x"]);
      if (flags["pin-y"] !== undefined) body.pin_y = Number(flags["pin-y"]);
    }

    const result = await requestApi(context, {
      method: "POST",
      path: `/api/${kind}/approve`,
      body,
    });
    printResult(result);
    return;
  }

  if (group === "site" && action === "publication-current") {
    const result = await requestApi(context, {
      method: "GET",
      path: "/api/site/publication-state/current",
    });
    printResult(result);
    return;
  }

  if (group === "project" && action === "create") {
    const name = requireValue(flags, "name");
    const description = requireValue(flags, "description");
    const floorId = requireValue(flags, "floor-id");
    const roomName = requireValue(flags, "room-name");
    const projectGenre = requireValue(flags, "project-genre");
    const teamName = requireValue(flags, "team-name");
    const placeType = parsePlaceType(flags["place-type"]);
    const buildingId = typeof flags["building-id"] === "string" ? flags["building-id"].trim() : "";
    const picture = typeof flags.picture === "string" ? flags.picture.trim() : "";
    const pinX = parseOptionalCoordinate(flags["pin-x"], "pin-x");
    const pinY = parseOptionalCoordinate(flags["pin-y"], "pin-y");
    const shouldApprove = flags.approve === undefined ? false : parseBoolean(flags.approve, "approve");

    if ((pinX === undefined) !== (pinY === undefined)) {
      throw new CliError("--pin-x and --pin-y must be provided together");
    }

    const saveDraftBody = {
      name,
      description,
      floor_id: floorId,
      room_name: roomName,
      project_genre: projectGenre,
      team_name: teamName,
      place_type: placeType,
      ...(buildingId ? { building_id: buildingId } : {}),
      ...(picture ? { picture } : {}),
    };

    const saveDraftResult = await requestApi(context, {
      method: "POST",
      path: "/api/project_draft/save",
      body: saveDraftBody,
    });

    const createdDraftId =
      saveDraftResult &&
      saveDraftResult.data &&
      typeof saveDraftResult.data === "object" &&
      saveDraftResult.data.draft &&
      typeof saveDraftResult.data.draft.id === "string"
        ? saveDraftResult.data.draft.id
        : "";

    if (!createdDraftId) {
      throw new CliError("project draft created but draft id is missing");
    }

    let mapPinDraftResult = null;
    if (pinX !== undefined && pinY !== undefined) {
      mapPinDraftResult = await requestApi(context, {
        method: "POST",
        path: "/api/map_pin_draft/save",
        body: {
          project_draft_id: createdDraftId,
          floor_id: floorId,
          ...(buildingId ? { building_id: buildingId } : {}),
          x: pinX,
          y: pinY,
          type: "Room",
        },
      });
    }

    let approveResult = null;
    if (shouldApprove) {
      approveResult = await requestApi(context, {
        method: "POST",
        path: "/api/project_draft/approve",
        body: {
          draft_id: createdDraftId,
          ...(pinX !== undefined && pinY !== undefined ? { pin_x: pinX, pin_y: pinY } : {}),
        },
      });
    }

    printResult({
      ok: true,
      command: "project create",
      baseUrl: context.baseUrl,
      status: approveResult ? approveResult.status : saveDraftResult.status,
      approved: shouldApprove,
      data: {
        draft: saveDraftResult.data,
        mapPinDraft: mapPinDraftResult ? mapPinDraftResult.data : null,
        project: approveResult ? approveResult.data : null,
      },
    });
    return;
  }

  if (group === "food" && action === "create") {
    const foodPlaceId = requireValue(flags, "food-place-id");
    const name = requireValue(flags, "name");
    const category = parseEnum(flags.category, "category", ["MAIN", "SUB", "DESSERT"], "MAIN");
    const status = parseEnum(flags.status, "status", ["AVAILABLE", "FEW", "SOLDOUT"], "AVAILABLE");
    const price = parseNonNegativeInteger(flags.price, "price", 0);
    const foodIndex = flags["food-index"] === undefined ? null : parseNonNegativeInteger(flags["food-index"], "food-index");
    const photo = typeof flags.photo === "string" ? flags.photo.trim() : "";
    const allergens = parseStringArray(flags.allergens, "allergens", []);
    const shouldApprove = flags.approve === undefined ? false : parseBoolean(flags.approve, "approve");

    const saveDraftResult = await requestApi(context, {
      method: "POST",
      path: "/api/food_draft/save",
      body: {
        action: "CREATE",
        food_place_id: foodPlaceId,
        name,
        category,
        ...(photo ? { photo } : {}),
        price,
        status,
        allergens,
        ...(foodIndex !== null ? { food_index: foodIndex } : {}),
      },
    });

    const createdDraftId =
      saveDraftResult &&
      saveDraftResult.data &&
      typeof saveDraftResult.data === "object" &&
      saveDraftResult.data.draft &&
      typeof saveDraftResult.data.draft.id === "string"
        ? saveDraftResult.data.draft.id
        : "";

    if (!createdDraftId) {
      throw new CliError("food draft created but draft id is missing");
    }

    let approveResult = null;
    if (shouldApprove) {
      approveResult = await requestApi(context, {
        method: "POST",
        path: "/api/food_draft/approve",
        body: { draft_id: createdDraftId },
      });
    }

    printResult({
      ok: true,
      command: "food create",
      baseUrl: context.baseUrl,
      status: approveResult ? approveResult.status : saveDraftResult.status,
      approved: shouldApprove,
      data: {
        draft: saveDraftResult.data,
        food: approveResult ? approveResult.data : null,
      },
    });
    return;
  }

  if (group === "stamp" && action === "create") {
    const title = requireValue(flags, "title");
    const projectId = requireValue(flags, "project-id");
    const quizData = requireValue(flags, "quiz-data");
    const randomKey = requireValue(flags, "random-key");
    const index = parseNonNegativeInteger(flags.index, "index", 1);
    const shouldApprove = flags.approve === undefined ? false : parseBoolean(flags.approve, "approve");

    const saveDraftResult = await requestApi(context, {
      method: "POST",
      path: "/api/stamp_draft/save",
      body: {
        action: "CREATE",
        title,
        project_id: projectId,
        quiz_data: quizData,
        random_key: randomKey,
        index,
      },
    });

    const createdDraftId =
      saveDraftResult &&
      saveDraftResult.data &&
      typeof saveDraftResult.data === "object" &&
      saveDraftResult.data.draft &&
      typeof saveDraftResult.data.draft.id === "string"
        ? saveDraftResult.data.draft.id
        : "";

    if (!createdDraftId) {
      throw new CliError("stamp draft created but draft id is missing");
    }

    let approveResult = null;
    if (shouldApprove) {
      approveResult = await requestApi(context, {
        method: "POST",
        path: "/api/stamp_draft/approve",
        body: { draft_id: createdDraftId },
      });
    }

    printResult({
      ok: true,
      command: "stamp create",
      baseUrl: context.baseUrl,
      status: approveResult ? approveResult.status : saveDraftResult.status,
      approved: shouldApprove,
      data: {
        draft: saveDraftResult.data,
        stamp: approveResult ? approveResult.data : null,
      },
    });
    return;
  }

  if (group === "event" && action === "create") {
    const title = requireValue(flags, "title");
    const startTime = requireValue(flags, "start-time");
    const endTime = requireValue(flags, "end-time");
    const eventSpaceId = requireValue(flags, "event-space-id");
    const eventDateId = requireValue(flags, "event-date-id");
    const projectId = typeof flags["project-id"] === "string" ? flags["project-id"].trim() : "";
    const shouldApprove = flags.approve === undefined ? false : parseBoolean(flags.approve, "approve");

    const saveDraftResult = await requestApi(context, {
      method: "POST",
      path: "/api/event_draft/save",
      body: {
        action: "CREATE",
        title,
        start_time: startTime,
        end_time: endTime,
        event_space_id: eventSpaceId,
        event_date_id: eventDateId,
        ...(projectId ? { project_id: projectId } : {}),
      },
    });

    const createdDraftId =
      saveDraftResult &&
      saveDraftResult.data &&
      typeof saveDraftResult.data === "object" &&
      saveDraftResult.data.draft &&
      typeof saveDraftResult.data.draft.id === "string"
        ? saveDraftResult.data.draft.id
        : "";

    if (!createdDraftId) {
      throw new CliError("event draft created but draft id is missing");
    }

    let approveResult = null;
    if (shouldApprove) {
      approveResult = await requestApi(context, {
        method: "POST",
        path: "/api/event_draft/approve",
        body: { draft_id: createdDraftId },
      });
    }

    printResult({
      ok: true,
      command: "event create",
      baseUrl: context.baseUrl,
      status: approveResult ? approveResult.status : saveDraftResult.status,
      approved: shouldApprove,
      data: {
        draft: saveDraftResult.data,
        event: approveResult ? approveResult.data : null,
      },
    });
    return;
  }

  if (group === "site" && action === "publication-set") {
    const isPublished = parseBoolean(flags.published, "published");
    const result = await requestApi(context, {
      method: "POST",
      path: "/api/site/publication-state/update",
      body: { isPublished },
    });
    printResult(result);
    return;
  }

  if (group === "accounts" && action === "list") {
    const result = await requestApi(context, {
      method: "GET",
      path: "/api/auth/accounts",
    });
    printResult(result);
    return;
  }

  if (group === "accounts" && action === "create") {
    const name = requireValue(flags, "name");
    const password = requireValue(flags, "password");
    const role = requireValue(flags, "role");
    const result = await requestApi(context, {
      method: "POST",
      path: "/api/auth/accounts",
      body: { name, password, role },
    });
    printResult(result);
    return;
  }

  if (group === "accounts" && action === "delete") {
    const id = requireValue(flags, "id");
    const result = await requestApi(context, {
      method: "DELETE",
      path: `/api/auth/accounts/${encodeURIComponent(id)}`,
    });
    printResult(result);
    return;
  }

  if (group === "request") {
    const method = requireValue(flags, "method").toUpperCase();
    const endpointPath = requireValue(flags, "path");
    let body;
    if (typeof flags.body === "string") {
      try {
        body = JSON.parse(flags.body);
      } catch {
        throw new CliError("--body must be valid JSON");
      }
    }

    const result = await requestApi(context, {
      method,
      path: endpointPath,
      body,
    });
    printResult(result);
    return;
  }

  throw new CliError("Unknown command. Use --help for usage.");
}

run().catch((error) => {
  if (error instanceof CliError) {
    if (error.details) {
      printResult({
        ok: false,
        message: error.message,
        ...error.details,
      });
    } else {
      printResult({
        ok: false,
        message: error.message,
      });
    }
    process.exit(error.statusCode);
  }

  printResult({
    ok: false,
    message: "Unexpected error",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
