import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import db from "../db.server";
import { hashPassword, requireRole } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireRole(request, ["OWNER", "MANAGER"]);

  const teamMembers = await db.user.findMany({
    where: { merchantId: user.merchantId },
    orderBy: { createdAt: "asc" },
  });

  return json({ user, teamMembers });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireRole(request, ["OWNER", "MANAGER"]);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // 1. Create New Team Member / Support Agent
  if (intent === "add_member") {
    const name = (formData.get("name") as string)?.trim();
    const email = (formData.get("email") as string)?.toLowerCase().trim();
    const password = formData.get("password") as string;
    const role = (formData.get("role") as string) || "AGENT";

    if (!name || !email || !password) {
      return json({ error: "All fields are required to create a team member." }, { status: 400 });
    }

    if (password.length < 6) {
      return json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return json({ error: "A user with this email address already exists." }, { status: 400 });
    }

    await db.user.create({
      data: {
        merchantId: user.merchantId,
        email,
        name,
        role,
        passwordHash: hashPassword(password),
      },
    });

    return json({ success: `Added ${name} as ${role} successfully.` });
  }

  // 2. Toggle Active / Inactive Status
  if (intent === "toggle_status") {
    const targetUserId = formData.get("userId") as string;
    const currentStatus = formData.get("currentStatus") === "true";

    // Prevent deactivating oneself
    if (targetUserId === user.id) {
      return json({ error: "You cannot deactivate your own account." }, { status: 400 });
    }

    await db.user.update({
      where: { id: targetUserId },
      data: { isActive: !currentStatus },
    });

    return json({ success: "User status updated." });
  }

  // 3. Delete Team Member
  if (intent === "delete_member") {
    if (user.role !== "OWNER") {
      return json({ error: "Only the Store Owner can delete team members." }, { status: 403 });
    }

    const targetUserId = formData.get("userId") as string;
    if (targetUserId === user.id) {
      return json({ error: "You cannot delete your own account." }, { status: 400 });
    }

    await db.user.delete({
      where: { id: targetUserId },
    });

    return json({ success: "Team member removed." });
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function PortalTeam() {
  const { user, teamMembers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const isOwner = user.role === "OWNER";

  return (
    <div className="p-6 lg:p-10 space-y-8 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div>
        <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
          Organization Team & Permissions
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage support agents, managers, and role-based permissions for {user.merchant.shop}
        </p>
      </div>

      {actionData?.success && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
          ✅ {actionData.success}
        </div>
      )}
      {actionData?.error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium">
          ⚠️ {actionData.error}
        </div>
      )}

      {/* Grid: Left Team List, Right Add Member */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Team Members List */}
        <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6">
          <h2 className="text-base font-bold text-white mb-4 flex items-center justify-between">
            <span>Team Members ({teamMembers.length})</span>
            <span className="text-xs text-slate-400 font-normal">Active Roles</span>
          </h2>

          <div className="divide-y divide-slate-800/80">
            {teamMembers.map((member) => (
              <div key={member.id} className="py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-slate-800 to-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400">
                    {member.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white flex items-center gap-2">
                      <span>{member.name}</span>
                      {member.id === user.id && (
                        <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded font-mono">
                          (You)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{member.email}</div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                      member.role === "OWNER"
                        ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                        : member.role === "MANAGER"
                        ? "bg-blue-500/20 text-blue-300 border border-blue-500/40"
                        : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                    }`}
                  >
                    {member.role}
                  </span>

                  {/* Actions for Owner */}
                  {isOwner && member.id !== user.id && (
                    <div className="flex items-center gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle_status" />
                        <input type="hidden" name="userId" value={member.id} />
                        <input type="hidden" name="currentStatus" value={member.isActive ? "true" : "false"} />
                        <button
                          type="submit"
                          className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                            member.isActive
                              ? "border-slate-700 text-slate-400 hover:text-red-400"
                              : "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                          }`}
                        >
                          {member.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </Form>

                      <Form method="post">
                        <input type="hidden" name="intent" value="delete_member" />
                        <input type="hidden" name="userId" value={member.id} />
                        <button
                          type="submit"
                          onClick={(e) => {
                            if (!confirm(`Are you sure you want to remove ${member.name}?`)) {
                              e.preventDefault();
                            }
                          }}
                          className="text-slate-500 hover:text-red-400 text-xs p-1"
                          title="Remove user"
                        >
                          🗑️
                        </button>
                      </Form>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Add New Team Member Form */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 h-fit">
          <h2 className="text-base font-bold text-white mb-2 flex items-center gap-2">
            <span>➕</span> Add New Member / Agent
          </h2>
          <p className="text-xs text-slate-400 mb-5">
            Create an agent or manager account with direct access to the live WhatsApp Inbox.
          </p>

          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="add_member" />

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Full Name
              </label>
              <input
                type="text"
                name="name"
                required
                placeholder="e.g. John Doe"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Work Email Address
              </label>
              <input
                type="email"
                name="email"
                required
                placeholder="agent@brand.com"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Temporary Password
              </label>
              <input
                type="password"
                name="password"
                required
                minLength={6}
                placeholder="Min 6 characters"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Role & Permission Level
              </label>
              <select
                name="role"
                defaultValue="AGENT"
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="AGENT">AGENT (Live Support Inbox & Chat Only)</option>
                <option value="MANAGER">MANAGER (Inbox + Dashboard & Automations)</option>
                {isOwner && <option value="OWNER">OWNER (Full Administrative Access)</option>}
              </select>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl text-xs transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {isSubmitting ? "Creating User..." : "Add Member"}
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
