import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG } from '../../config/config.tokens';
import { AppConfig } from '../../config/configuration';
import { headerValue, prefixSegment } from './http-path.util';

/** Replay window: reject a signature whose timestamp is more than this many seconds
 *  from now (either direction). Bounds how long a captured request stays replayable. */
const REPLAY_WINDOW_SECONDS = 300;

/** Only well-formed lowercase/uppercase hex is accepted for `v1`. */
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * HMAC request-signature guard for the `/external` surface — the third-party rail webhooks
 * (outbound settlement callback + inbound credit). Bound globally (APP_GUARD) so no `/external`
 * endpoint can skip it, and it scopes itself to the `external` prefix (every other prefix is
 * another guard's concern, returned early).
 *
 * `/external` is a DISTINCT trust domain from `/internal` (our own network peers,
 * `X-Service-Token`) and `/api` (customers behind the gateway, `X-User-Id`): the caller is a
 * third-party rail, not a user or a peer service, so it authenticates with a Stripe-style HMAC
 * signature over the RAW request body — NOTHING else (never a user JWT, never the service token).
 *
 * The `X-Rail-Signature: t=<unix-seconds>,v1=<hex>` header carries a timestamp and an HMAC. The
 * guard recomputes `HMAC-SHA256(RAILS_WEBHOOK_SIGNING_SECRET, "<t>.<rawBody>")` over the exact
 * bytes the sender signed (`req.rawBody`, captured at bootstrap — NOT reparsed JSON, which a
 * serializer round-trip could alter) and compares it constant-time. A `t` outside a ±300s window
 * is rejected as a replay. A missing/malformed header, a stale timestamp, an absent raw body, or a
 * signature mismatch is 401 — with a GENERIC message that never reveals which check failed.
 *
 * There is NO health carve-out here: `/external` carries no health probe (health lives on
 * `/internal`). Fail-closed: `/EXTERNAL/*` still routes here (case-insensitive prefix match), and a
 * missing raw body rejects rather than passing.
 */
@Injectable()
export class RailSignatureGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    // Case-insensitive prefix match: Express routes `/EXTERNAL/*` here too, so we must fail
    // closed and still demand a valid signature (see prefixSegment).
    if (prefixSegment(req.path) !== 'external') {
      return true;
    }

    // 1. Parse the signature header (tolerant of field order/whitespace; both fields required).
    const signature = parseSignatureHeader(headerValue(req.headers['x-rail-signature']));
    if (!signature) {
      throw unauthorized();
    }

    // 2. Replay guard: reject a timestamp outside the ±window.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - signature.t) > REPLAY_WINDOW_SECONDS) {
      throw unauthorized();
    }

    // 3. Raw body must have been captured, or we cannot verify what was signed — fail closed.
    const raw = req.rawBody;
    if (!raw) {
      throw unauthorized();
    }

    // 4. Recompute the HMAC over "<t>.<rawBody>" and compare constant-time. Hex is
    //    case-insensitive, so normalize `v1` to lowercase to match `digest('hex')` — a valid
    //    upper/mixed-case signature must verify, not fail closed on representation alone.
    const expected = createHmac('sha256', this.config.rails.webhookSigningSecret)
      .update(`${signature.t}.${raw.toString('utf8')}`)
      .digest('hex');
    if (!constantTimeEquals(signature.v1.toLowerCase(), expected)) {
      throw unauthorized();
    }

    return true;
  }
}

interface ParsedSignature {
  t: number;
  v1: string;
}

/**
 * Parse `t=<unix-seconds>,v1=<hex>` — tolerant of field order and surrounding whitespace. Both
 * fields are REQUIRED; `t` must be an integer and `v1` non-empty hex. Any deviation returns null
 * (the caller maps that to a 401).
 */
function parseSignatureHeader(raw: string | undefined): ParsedSignature | null {
  if (!raw) {
    return null;
  }

  let timestamp: string | undefined;
  let v1: string | undefined;
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      v1 = value;
    }
  }

  if (timestamp === undefined || v1 === undefined) {
    return null;
  }
  if (!/^-?\d+$/.test(timestamp)) {
    return null;
  }
  const t = Number.parseInt(timestamp, 10);
  if (!Number.isInteger(t)) {
    return null;
  }
  if (v1.length === 0 || !HEX_PATTERN.test(v1)) {
    return null;
  }
  return { t, v1 };
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException('Invalid or missing rail signature');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
