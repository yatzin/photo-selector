import "dotenv/config"
import { PrismaClient } from "../app/generated/prisma/client"
import { PrismaLibSql } from "@prisma/adapter-libsql"
import bcrypt from "bcryptjs"

const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db"
const adapter = new PrismaLibSql({ url })
const prisma = new PrismaClient({ adapter })

async function main() {
  const existing = await prisma.user.findFirst({ where: { role: "ADMIN" } })
  if (existing) {
    console.log("Admin user already exists — skipping seed.")
    return
  }

  // Read from env vars; fall back to insecure defaults that force a password reset
  const name = process.env.ADMIN_NAME ?? "Admin"
  const email = process.env.ADMIN_EMAIL ?? "admin@localhost"
  const password = process.env.ADMIN_PASSWORD ?? "changeme"
  const mustReset = !process.env.ADMIN_PASSWORD // force reset only when using the default

  const passwordHash = await bcrypt.hash(password, 12)
  const admin = await prisma.user.create({
    data: { name, email, passwordHash, role: "ADMIN", mustResetPassword: mustReset },
  })

  console.log(`Created admin: ${admin.email}`)
  if (mustReset) {
    console.log(`Default password: ${password} — you will be prompted to change it on first login.`)
    console.log("Tip: set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD env vars before seeding to skip this.")
  } else {
    console.log("Admin created with the password you provided.")
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
