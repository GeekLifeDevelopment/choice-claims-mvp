import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '../prisma'
import type { AuditAction } from '../domain/audit'

type AuditLogClient = Pick<PrismaClient, 'auditLog'> | Pick<Prisma.TransactionClient, 'auditLog'>

type WriteAuditLogInput = {
  action: AuditAction
  claimId?: string
  metadata?: unknown
  fieldName?: string
  oldValue?: unknown
  newValue?: unknown
  client?: AuditLogClient
}

type WriteAuditLogResult =
  | {
      ok: true
      auditLogId: string
      action: AuditAction
      claimId?: string
    }
  | {
      ok: false
      action: AuditAction
      claimId?: string
      error: unknown
    }

function toNullableJsonValue(
  value: unknown
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null) {
    return Prisma.JsonNull
  }

  return value as Prisma.InputJsonValue
}

export async function writeAuditLog(input: WriteAuditLogInput): Promise<WriteAuditLogResult> {
  const client = input.client ?? prisma

  try {
    const created = await client.auditLog.create({
      data: {
        action: input.action,
        ...(input.claimId ? { claimId: input.claimId } : {}),
        ...(input.fieldName ? { fieldName: input.fieldName } : {}),
        ...(input.oldValue !== undefined ? { oldValue: toNullableJsonValue(input.oldValue) } : {}),
        ...(input.newValue !== undefined ? { newValue: toNullableJsonValue(input.newValue) } : {}),
        ...(input.metadata !== undefined ? { metadata: toNullableJsonValue(input.metadata) } : {})
      },
      select: {
        id: true,
        action: true,
        claimId: true
      }
    })

    console.info('[AUDIT] audit log written', {
      action: created.action,
      auditLogId: created.id,
      claimId: created.claimId
    })

    return {
      ok: true,
      auditLogId: created.id,
      action: input.action,
      claimId: created.claimId ?? undefined
    }
  } catch (error) {
    console.error('[AUDIT] audit log failed', {
      action: input.action,
      claimId: input.claimId,
      error
    })

    return {
      ok: false,
      action: input.action,
      claimId: input.claimId,
      error
    }
  }
}
