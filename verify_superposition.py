# -*- coding: utf-8 -*-
"""叠加原理 / 齐次化原理的严格数值验证 (网格加密 + Richardson 外推)。"""
import numpy as np

c = 1.0
gauss = lambda s, aa, sg=0.7: np.exp(-((s - aa) ** 2) / (2 * sg * sg))
phi = lambda s: gauss(s, -0.6, 0.7)
psi = lambda s: 0.6 * np.sin(2.0 * s) * np.exp(-0.3 * s * s)
src = lambda s, t: np.exp(-(s * s) / 0.6 - ((t - 1.2) ** 2) / 0.18)
x0, t0 = 2.1, 2.6


def solve(nx_target, which):
    """CFL=1 蛙跳; which ∈ {phi, psi, src, full}"""
    L = 10.0
    dx = 2 * L / (nx_target - 1)
    dt = dx / c
    xs = np.linspace(-L, L, nx_target)
    nsteps = int(round(t0 / dt))
    nsteps = max(nsteps, 2)
    U = np.zeros((nsteps + 1, nx_target))
    u0 = phi(xs) if which in ("phi", "full") else np.zeros(nx_target)
    v0 = psi(xs) if which in ("psi", "full") else np.zeros(nx_target)
    f = src if which in ("src", "full") else None
    U[0] = u0
    uxx = np.zeros(nx_target)
    uxx[1:-1] = (u0[2:] - 2 * u0[1:-1] + u0[:-2]) / (dx * dx)
    f0 = 0.0 if f is None else f(xs[1:-1], 0.0)
    U[1, 1:-1] = u0[1:-1] + dt * v0[1:-1] + 0.5 * dt * dt * (c * c * uxx[1:-1] + f0)
    for n in range(1, nsteps):
        fs = 0.0 if f is None else dt * dt * f(xs[1:-1], n * dt)
        U[n + 1, 1:-1] = U[n, 2:] + U[n, :-2] - U[n - 1, 1:-1] + fs
    i = int(round((x0 + L) / dx))
    return U[nsteps, i], xs, U[nsteps]


# 精确值
u_phi_ex = 0.5 * (phi(np.array([x0 - c * t0]))[0] + phi(np.array([x0 + c * t0]))[0])
xg = np.linspace(x0 - c * t0, x0 + c * t0, 800001)
u_psi_ex = np.trapezoid(psi(xg), xg) / (2 * c)
tt = np.linspace(0.0, t0, 10401)                # 锥积分 (高密度, 使积分误差 << 离散误差)
acc = 0.0
for tk in tt:
    h = c * (t0 - tk)
    if h <= 0:
        continue
    xgg = np.linspace(x0 - h, x0 + h, max(3, int(4000 * h) + 1))
    acc += np.trapezoid(src(xgg, tk), xgg) * (tt[1] - tt[0])
u_src_ex = acc / (2 * c)

print("精确值: u^phi = %.12f   u^psi = %.12f   u^src = %.12f" % (u_phi_ex, u_psi_ex, u_src_ex))
print()
print("网格加密收敛 (CFL=1):")
print("%10s %14s %14s %14s %14s" % ("nx", "u^phi(num)", "u^psi(num)", "u^src(num)", "u^full(num)"))
prev = {}
for nx_target in (8001, 16001, 32001):
    row = {}
    for k in ("phi", "psi", "src", "full"):
        row[k] = solve(nx_target, k)[0]
    print("%10d %14.9f %14.9f %14.9f %14.9f" % (nx_target, row["phi"], row["psi"], row["src"], row["full"]))
    errs = (abs(row["phi"] - u_phi_ex), abs(row["psi"] - u_psi_ex),
            abs(row["src"] - u_src_ex), abs(row["full"] - (u_phi_ex + u_psi_ex + u_src_ex)))
    print("%10s %14.2e %14.2e %14.2e %14.2e" % ("|误差|", *errs))
    if prev:
        for k, lab in zip(("phi", "psi", "src", "full"), ("phi", "psi", "src", "full")):
            pass
        e0 = abs(prev["full"] - (u_phi_ex + u_psi_ex + u_src_ex))
        e1 = errs[3]
        if e0 > 0:
            print("%10s full 误差比 = %.3f  (二阶收敛应 ≈ 4)" % ("ratio", e0 / e1))
    prev = row

# 叠加性 (同一网格上, 三个子算例之和 vs 全量算例)
print()
for nx_target in (8001, 16001, 32001):
    rp = solve(nx_target, "phi")[0]
    rq = solve(nx_target, "psi")[0]
    rs = solve(nx_target, "src")[0]
    rf = solve(nx_target, "full")[0]
    print("nx = %6d : 全量 - (三项之和) = %.3e" % (nx_target, abs(rf - (rp + rq + rs))))
