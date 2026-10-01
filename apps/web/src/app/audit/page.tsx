"use client";

import { AuditList } from "@pantau/contracts";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { useSession } from "@/components/session";
import { AppFrame } from "@/components/shell";
import { StateBlock } from "@/components/ui";
import { ApiError, getJson } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { AUDIT_LABEL, formatDateTime, REASON_LABEL } from "@/lib/format";
import { can } from "@/lib/roles";

type Item = z.infer<typeof AuditList>["items"][number];
type State = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; items: Item[] };

const FACTS: [string, string][] = [
  ["host", "alamat"],
  ["port", "port"],
  ["brand", "merek"],
  ["model", "model"],
  ["cameraCount", "kamera"],
  ["bytes", "ukuran (byte)"],
];

function detail(meta: Record<string, unknown>): string {
  const parts = FACTS.filter(([k]) => meta[k] !== undefined && meta[k] !== "").map(
    ([k, label]) => `${label} ${String(meta[k])}`,
  );
  if (typeof meta.reason === "string") parts.push(`sebab: ${REASON_LABEL[meta.reason] ?? meta.reason}`);
  return parts.join(" · ");
}

function AuditView() {
  const { role } = useSession();
  const [limit, setLimit] = useState("50");
  const [state, setState] = useState<State>({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const r = await getJson(`/v1/audit?limit=${limit}`, AuditList);
      setState({ status: "ready", items: r.items });
    } catch (e) {
      setState({ status: "error", error: e });
    }
  }, [limit]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="h-page">Audit</h1>
      <p className="mt-1 text-muted">
        Catatan penambahan perangkat dan pengambilan snapshot di organisasi ini. Hanya pemilik yang dapat
        membacanya.
      </p>
      {!can.audit(role) && state.status !== "error" ? (
        <p className="mt-2 text-muted">Peran Anda bukan pemilik; server akan menolak permintaan ini.</p>
      ) : null}
      <div className="mt-4 max-w-xs">
        <label className="label" htmlFor="batas">
          Jumlah catatan terbaru
        </label>
        <select id="batas" className="field" value={limit} onChange={(e) => setLimit(e.target.value)}>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>
      <div className="mt-4">
        {state.status === "loading" ? (
          <StateBlock kind="loading" title="Memuat catatan audit…" />
        ) : state.status === "error" ? (
          (() => {
            const m = describeError(state.error);
            const forbidden = state.error instanceof ApiError && state.error.status === 403;
            return (
              <StateBlock
                kind={forbidden ? "forbidden" : "error"}
                title={forbidden ? "Hanya pemilik organisasi yang boleh membaca audit." : m.title}
                hint={forbidden ? "Peran Anda tidak mencukupi. Minta pemilik membukanya." : m.hint}
                action={
                  forbidden ? undefined : (
                    <button type="button" className="btn" onClick={() => void load()}>
                      Coba lagi
                    </button>
                  )
                }
              />
            );
          })()
        ) : state.items.length === 0 ? (
          <StateBlock
            kind="empty"
            title="Belum ada catatan audit."
            hint="Catatan muncul setelah perangkat ditambahkan atau snapshot diambil."
          />
        ) : (
          <ol className="border-t border-hair">
            {state.items.map((i) => (
              <li
                key={i.id}
                className="grid gap-x-4 gap-y-1 border-b border-hair py-3 min-[900px]:grid-cols-[13rem_14rem_1fr]"
              >
                <time dateTime={i.at} className="mono">
                  {formatDateTime(i.at)}
                </time>
                <strong>{AUDIT_LABEL[i.action] ?? i.action}</strong>
                <div className="min-w-0 text-muted">
                  {i.target ? <span className="mono block">{i.target}</span> : null}
                  <span className="block">{detail(i.meta) || "Tanpa rincian"}</span>
                  <span className="mono block">
                    aktor {i.actorId ?? "tidak diketahui"} · IP {i.ip ?? "tidak tercatat"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export default function AuditPage() {
  return (
    <AppFrame>
      <AuditView />
    </AppFrame>
  );
}
