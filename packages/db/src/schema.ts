import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---- Better Auth tables ----
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull(),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: text("metadata"),
});
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull(),
  activeOrganizationId: text("active_organization_id"),
});
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  inviterId: text("inviter_id").notNull(),
});

// ---- Tenant tables (RLS) ----
export const site = pgTable("site", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  timezone: text("timezone").notNull().default("Asia/Makassar"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const device = pgTable("device", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  siteId: text("site_id").notNull(),
  /** Set when the device was discovered by an agent (PRD section 8); null for manually added devices. */
  agentId: text("agent_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  brand: text("brand").notNull().default(""),
  model: text("model").notNull().default(""),
  firmware: text("firmware").notNull().default(""),
  adapterId: text("adapter_id").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  capabilities: jsonb("capabilities").notNull().default({}),
  status: text("status").notNull().default("online"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const deviceSecret = pgTable("device_secret", {
  deviceId: text("device_id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  credentialsEnc: text("credentials_enc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const camera = pgTable("camera", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  deviceId: text("device_id").notNull(),
  channel: text("channel").notNull(),
  name: text("name").notNull(),
  hasPtz: boolean("has_ptz").notNull().default(false),
  mainCodec: text("main_codec"),
  subCodec: text("sub_codec"),
  status: text("status").notNull().default("online"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  ip: text("ip"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta").notNull().default({}),
});
export const cameraGrant = pgTable("camera_grant", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  permission: text("permission").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- agents (PRD section 8: agent, agent_enrollment). Tokens are stored hashed only. ----
export const agent = pgTable("agent", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  siteId: text("site_id").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull().default(""),
  publicKey: text("public_key"),
  tokenHash: text("token_hash").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const agentEnrollment = pgTable("agent_enrollment", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  siteId: text("site_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
