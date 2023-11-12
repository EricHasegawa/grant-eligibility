export const maxDuration = 300

import { NextResponse, type NextRequest } from 'next/server'
import https from 'https'
import path from 'path'
import fs from 'fs'
import { BadRequestError, OpenAI } from 'openai'
import { kv } from '@vercel/kv'
import { Ratelimit } from '@upstash/ratelimit'

type OpenAIErrorObj = {
  message?: string
  code?: string
  param?: string
  type?: string
}

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!request.body) return NextResponse.json('No request body provided.')
  const reqBody = await request.json()

  const pdfLink = reqBody.pdfLink
  if (!pdfLink) return NextResponse.json('No pdf URL provided.')

  const userIP = request.headers.get('x-forwarded-for')
  const rateLimited = await isIPRateLimited(userIP)
  if (rateLimited) {
    return NextResponse.json({
      code: 'rate_limit_exceeded',
      errorMsg: 'Rate limit exceeded.' 
    }, 
    { status: 429 })
  }

  const openAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  })

  let filePath
  try {
    filePath = await downloadFile(pdfLink, 'grant.pdf')
  } catch (err) {
    if (err instanceof TypeError) {
      if (err.message === 'Invalid URL') {
        return NextResponse.json({
          code: 'invalid_pdf_url',
          errorMsg: 'Invalid PDF URL.' 
        }, 
        { status: 400 })
      }
    }
  }

   if (!filePath) return NextResponse.json('Upload to OpenAI failed.')

  const file = await openAI.files.create({
    file: fs.createReadStream(filePath),
    purpose: 'assistants',
  })


  // Clean up: delete local file after uploading to OpenAI.
  deleteFile(filePath)

  let assistant
  try {
    assistant = await openAI.beta.assistants.create({
      name: 'Eligibility creator',
      description:
          'Parses the eligibility from a grant PDF into a ' +
          'structured format.',
      instructions:
          'You are an expert grant consultant hired to ' +
          'parse the eligibility criteria of a grant into a structured ' +
          'format. You will be given a grant PDF and asked to find the ' +
          'attributes that an organization must have and not have to ' +
          'qualify for the grant. You will also be asked to identify the ' +
          'types of organizations that are eligible to be the prime ' +
          'applicant and the types of organizations that are eligible to ' +
          'be a sub applicant.',
      model: 'gpt-4-1106-preview',
      tools: [
          { type: 'retrieval' },
          {
              type: 'function',
              function: checkEligibilityFunction,
          },
      ],
      file_ids: [file.id],
    })
  } catch (err) {
    if (err instanceof BadRequestError) {
      // Type gymnastics to make error message type-compliant.
      const openAIError = err.error as OpenAIErrorObj
      const errorMsg = openAIError.message
      // TODO(@EricHasegawa): Make this less fragile.
      if (errorMsg?.startsWith('Failed to index file: Unsupported file')) {
        return NextResponse.json({
          code: 'unsupported_file_type',
          errorMsg: 'Unsupported file type.' 
        }, 
        { status: 400 })
      }
    }
  }

  if (!assistant) return NextResponse.json('Assistant creation failed.')

  const thread = await openAI.beta.threads.create({
    messages: [
        {
            role: 'user',
            content:
                'Return the eligibility criteria for this grant. ' +
                'Here are some helpful tips: ' +
                '- Prime applicants are the main applicants for a grant. ' +
                'They are able to qualify by themselves. ' +
                '- Sub applicants are the secondary applicants for a grant. ' +
                'They usually do not qualify by themselves, but can ' +
                'qualify if they are paired with a prime applicant. ' +
                '- Each qualifier is an actual requirement that the ' +
                'applicant must meet to qualify for the grant. ' +
                '- Disqualifiers are things that prohibit the applicant ' +
                'from being eligible for the grant. ' +
                'Parse it out of the overall document and MAKE SURE you ' +
                'Return it according to the format in the ' +
                'checkEligibility function.',
            file_ids: [file.id],
        },
    ],
  })

  let run = await openAI.beta.threads.runs.create(thread.id, {
    assistant_id: assistant.id,
  })

  let runResults
  while (!runResults) {
      // Poll results every second.
      await new Promise((r) => setTimeout(r, 1000))
      run = await openAI.beta.threads.runs.retrieve(thread.id, run.id)
      if (run.status !== 'in_progress') {
          runResults = run
          break
      }
  }

  // Clean up: delete file and assistant.
  await openAI.files.del(file.id)
  await openAI.beta.assistants.del(assistant.id)

  if (runResults.status === 'failed') {
      if (runResults.last_error?.code === 'rate_limit_exceeded') {
          return NextResponse.json({
            code: 'openai_rate_limit_exceeded',
            errorMsg: 'OpenAI API rate limit exceeded.' 
          }, 
          { status: 429 })
      }
      // TODO(@EricHasegawa): Handle other errors
      return new NextResponse()
  }

  if (!(runResults.status === 'requires_action')) {
    // Assistant returned something unexpected.
    return NextResponse.json({
      code: 'assistant_error',
      errorMsg: 'AI assistant returned something unexpected. \n' + 
      'It does that sometimes :( \n' +
      '... \n \n \n' +
      'Anyways please try again',
    }, 
    { status: 500 })
  }

  const requiredAction = runResults.required_action

  if (!requiredAction || !(requiredAction?.type === 'submit_tool_outputs')) {
      return NextResponse.json({
        code: 'assistant_error',
        errorMsg: 'AI assistant returned something unexpected. \n' + 
        'It does that sometimes :( \n' +
        '... \n \n \n' +
        'Anyways please try again',
      }, 
      { status: 500 })
  }

  const toolCalls = requiredAction.submit_tool_outputs.tool_calls
  const criteriaCall = toolCalls[0]
  return NextResponse.json({criteria: criteriaCall}, { status: 200 })
}

const isIPRateLimited = async (ip: string | null): Promise<boolean> => {
  if (!ip) return false

  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const ratelimit = new Ratelimit({
      redis: kv,
      // rate limit to 5 requests per 10 seconds
      limiter: Ratelimit.slidingWindow(3, '60s')
    })

    const { success } = await ratelimit.limit(
      `ratelimit_${ip}`
    )
    return !success
  }
  return false
}

const checkEligibilityFunction = {
  name: 'checkEligibility',
  description: 'Checks if an org is eligible for a grant',
  parameters: {
      type: 'object',
      properties: {
          filename: {
              type: 'string',
              description: 'The filename of the grant.',
          },
          eligibility: {
              type: 'object',
              description: 'The eligibility criteria.',
              properties: {
                  prime_applicant_types: {
                      type: 'array',
                      description:
                          'Types of organizations that are eligible ' +
                          'to be the prime applicant for the grant.',
                      items: {
                          type: 'string',
                          description: 'The type of organization.',
                      },
                  },
                  sub_applicant_types: {
                      type: 'array',
                      description:
                          'Types of organizations that are eligible ' +
                          'to be a sub applicant for the grant.',
                      items: {
                          type: 'string',
                          description: 'The type of organization.',
                      },
                  },
                  qualifiers: {
                      type: 'array',
                      description:
                          'Requirements that are necessary for ' +
                          'an organization to qualify for the grant.',
                      items: {
                          type: 'string',
                          description: 'The attribute.',
                      },
                  },
                  disqualifiers: {
                      type: 'array',
                      description:
                          'Attributes that disqualify an organization ' +
                          'from qualifying for the grant.',
                      items: {
                          type: 'string',
                          description: 'The attribute.',
                      },
                  },
              },
          },
      },
  },
}

// Downloads a file directly to "servers" /tmp directory.
const downloadFile = async (
  grantUrl: string,
  fileName: string, // Must include extension.
): Promise<string> => {
  // Wrap in promise so we can use async await
  return new Promise((resolve, reject) => {
      https.get(grantUrl, (res) => {
          // Must be in /tmp for Vercel write access.
          const pathName = path.join(`/tmp/${fileName}`)
          const filePath = fs.createWriteStream(pathName)
          res.pipe(filePath)
          filePath.on('finish', () => {
              filePath.close()
              resolve(pathName)
          })
          filePath.on('error', (err) => {
              fs.unlink(pathName, () => {
                  console.log('error!!!' + err)
                  reject(err)
              })
          })
      })
  })
}

const deleteFile = (filePath: string): boolean => {
  fs.unlink(filePath, (err) => {
      if (err) {
          return false
      }
  })
  return true
}
