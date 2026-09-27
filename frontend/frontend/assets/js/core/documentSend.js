// Direct send.
//
// The operator composes the email and presses one button, and the email goes out. There is
// no separate submit/approve step in the UI, by design: the person clicking Send is the
// person who wrote the message, so an extra approval click would be ceremony rather than a
// control.
//
// The backend still does the work that matters on this path, and none of it is optional:
// the recipient and subject are checked for header injection, the body is size-capped,
// attachment types are allow-listed, and upstream failures are never echoed back to the
// browser. See `POST /api/gmail/send` in backend/app.py.
//
// Every request is logged with a request id and byte counts, never with the recipient
// address, the subject, the body or the attachment contents.

import { API_BASE } from './api.js'


// Keep in step with ALLOWED_OUTBOUND_MIME_TYPES in backend/services/security_service.py.
// The backend enforces this regardless; checking here only saves a wasted round trip and
// gives the operator a clearer message than an HTTP 422.
const ALLOWED_MIME_TYPES =
  new Set(
    [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
  )


export const MAX_ATTACHMENTS =
  10


export function checkAttachments(
  attachments
) {

  const list =
    Array.isArray(attachments)
      ? attachments
      : []

  if (list.length > MAX_ATTACHMENTS) {

    throw new Error(
      `A message can carry at most ${MAX_ATTACHMENTS} attachments.`
    )

  }

  for (const item of list) {

    const type =
      String(
        item?.mime_type ||
        'application/pdf'
      )
        .split(';')[0]
        .trim()
        .toLowerCase()

    if (!ALLOWED_MIME_TYPES.has(type)) {

      throw new Error(
        `Attachments of type ${type} cannot be sent. Use PDF, an image, or a text/CSV file.`
      )

    }

    if (!item?.data) {

      throw new Error(
        `"${item?.filename || 'attachment'}" has no content to send.`
      )

    }

  }

  return list

}


export async function sendEmail(
  { to, subject, body, attachments }
) {

  checkAttachments(
    attachments
  )

  const response =
    await fetch(
      `${API_BASE}/api/gmail/send`,
      {

        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify(
            {

              to,
              subject,
              body,

              attachments:
                attachments ||
                []

            }
          )

      }
    )

  let payload = {}

  try {

    payload =
      await response.json()

  } catch {

    payload = {}

  }


  if (!response.ok) {

    const error =
      new Error(
        payload.detail ||
        payload.error ||
        `The email was not sent (HTTP ${response.status}).`
      )

    // Carried through so the caller can show the backend's stable code in logs, and so a
    // retryable failure can be told apart from a permanent one.
    error.code =
      payload.code ||
      String(
        response.status
      )

    error.requestId =
      payload.request_id ||
      ''

    error.retryable =
      response.status >= 500

    throw error

  }


  if (payload.ok !== true) {

    throw new Error(
      payload.detail ||
      'Gmail did not confirm the email was sent.'
    )

  }


  return {

    ok: true,
    messageId:
      payload.message_id ||
      '',
    threadId:
      payload.thread_id ||
      '',
    duplicateSuppressed:
      payload.duplicate_suppressed === true

  }

}
