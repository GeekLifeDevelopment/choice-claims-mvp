type ReadCognitoBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; error: 'invalid_json' }

export async function readCognitoBody(request: Request): Promise<ReadCognitoBodyResult> {
  try {
    const body = await request.json()
    return { ok: true, body }
  } catch {
    return { ok: false, error: 'invalid_json' }
  }
}
