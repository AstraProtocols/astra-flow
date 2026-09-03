import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
      <p className="text-xs uppercase tracking-[0.28em] text-cyan">AstraProtocols</p>
      <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight text-white sm:text-6xl">
        Conditional escrow for milestone work on Stellar.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-slate-300">
        Astra Flow locks USDC or XLM until proofs clear. Recipients submit hashes, funders
        unlock payouts, and arbitrators resolve disputes — all on Soroban.
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/dashboard"
          className="rounded-full bg-cyan px-6 py-3 text-sm font-medium text-midnight"
        >
          Open dashboard
        </Link>
        <a
          href="https://github.com/AstraProtocols/astra-flow"
          className="rounded-full border border-white/15 px-6 py-3 text-sm text-slate-200"
        >
          View source
        </a>
      </div>
    </main>
  );
}
