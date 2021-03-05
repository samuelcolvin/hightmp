import {html_response, HttpError, json_response, View} from './utils'
import {check_create_auth, create_random_hex, check_upload_auth, UploadInfo} from './auth'
import {INFO_FILE_NAME, PUBLIC_KEY_LENGTH} from './constants'

declare const HIGH_TMP: KVNamespace


interface SiteSummary {
  files?: string[]
}

async function site_summary(public_key: string): Promise<SiteSummary> {
  const raw = await HIGH_TMP.get(`site:${public_key}:${INFO_FILE_NAME}`, 'json')
  const obj = raw as Record<string, any>
  const files = await HIGH_TMP.list({prefix: `site:${public_key}:`})
  obj.files = files.keys.map(k => k.name.substr(30)).filter(f => f != INFO_FILE_NAME)
  return obj
}

function* get_index_options (public_key: string, path: string) {
  yield `site:${public_key}:${path}index.html`
  yield `site:${public_key}:${path.slice(0, -1)}.html`
  yield `site:${public_key}:${path}index.json`
}

async function get_file(request: Request, public_key: string, path: string): Promise<Response> {
  if (path === INFO_FILE_NAME) {
    return json_response(await site_summary(public_key))
  }

  let v = await HIGH_TMP.getWithMetadata(`site:${public_key}:${path}`, 'stream')

  if (!v.value && path.endsWith('/')) {
    const index_options = get_index_options(public_key, path)
    let next
    while (!v.value && !(next = index_options.next()).done) {
      v = await HIGH_TMP.getWithMetadata(next.value as string, 'stream')
    }

    if (!v.value && path == '/') {
      return json_response({
        message: `The site (${public_key} has no index file, hence this summary response`,
        summary: await site_summary(public_key)
      })
    }
  }
  let status = 200

  if (!v.value) {
    // check if we have a 404.html or 404.txt file, if so use that and change the status, else throw a generic 404
    v = await HIGH_TMP.getWithMetadata(`site:${public_key}:/404.html`, 'stream')
    if (!v.value) {
      v = await HIGH_TMP.getWithMetadata(`site:${public_key}:/404.txt`, 'stream')
    }
    if (!v.value) {
      throw new HttpError(404, `File "${path}" not found in site "${public_key}"`)
    } else {
      status = 404
    }
  }

  const headers: Record<string, string> = {}
  const metadata: {content_type: string | null} | null = v.metadata as any
  if (metadata && metadata.content_type) {
    headers['content-type'] = metadata.content_type
  }
  return new Response(v.value, {status, headers})
}

async function post_file(request: Request, public_key: string, path: string): Promise<Response> {
  const site_expiration = await check_upload_auth(public_key, request)
  if (path == INFO_FILE_NAME) {
    throw new HttpError(403, `Overwriting "${INFO_FILE_NAME}" is forbidden`)
  }

  const content_type = request.headers.get('content-type')
  const blob = await request.blob()
  await HIGH_TMP.put(`site:${public_key}:${path}`, blob.stream(), {
    expiration: site_expiration,
    metadata: {content_type}
  })

  return json_response({path, content_type})
}

export const views: View[] = [
  {
    match: '/',
    allow: 'GET',
    view: async () =>
      html_response(`
<h1>Index</h1>

<p>This is the index page, it doesn't say much interesting yet</p>
`),
  },
  {
    match: '/create/',
    allow: 'POST',
    view: async (request, info) => {
      await check_create_auth(request)
      const public_key = create_random_hex(PUBLIC_KEY_LENGTH)
      const secret_key = 'sk_' + create_random_hex(60)

      if (await HIGH_TMP.get(`site:${public_key}:${INFO_FILE_NAME}`)) {
        // shouldn't happen
        throw new HttpError(409, 'Site with this public key already exists')
      }

      const creation = new Date()
      const site_expiration_date = new Date(creation.getTime() + 30 * 24 * 3600 * 1000)
      const upload_expiration_date = new Date(creation.getTime() + 3600 * 1000)
      const site_expiration = Math.round(site_expiration_date.getTime() / 1000)

      const upload_info: UploadInfo = {site_expiration, secret_key}
      await HIGH_TMP.put(`site:${public_key}|upload`, JSON.stringify(upload_info), {
        expiration: upload_expiration_date.getTime() / 1000,
      })
      const site_info = {
        public_key,
        url: `https://${info.url.hostname}/${public_key}/`,
        site_creation: creation.toISOString(),
        site_expiration: site_expiration_date.toISOString(),
        upload_expiration: upload_expiration_date.toISOString(),
      }
      await HIGH_TMP.put(`site:${public_key}:${INFO_FILE_NAME}`, JSON.stringify(site_info, null, 2), {
        expiration: site_expiration,
      })

      return json_response({
        message: 'New site created successfully',
        secret_key,
        ...site_info
      })
    },
  },
  {
    match: new RegExp(`^\\/([a-f0-9]{${PUBLIC_KEY_LENGTH})(\\/.*)`),
    allow: ['GET', 'POST'],
    view: async (request, info) => {
      const [, public_key, path] = info.match as RegExpMatchArray
      if (request.method == 'GET') {
        return await get_file(request, public_key, path)
      } else {
        // method == 'POST'
        return await post_file(request, public_key, path)
      }
    }
  },
]