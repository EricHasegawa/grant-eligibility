import { NextResponse, type NextRequest } from 'next/server'
import https from 'https'
import path from 'path'
import fs from 'fs'
import { OpenAI } from 'openai'

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!request.body) return NextResponse.json('No request body provided.')
  const reqBody = await request.json()

  const pdfLink = reqBody.pdfLink
  if (!pdfLink) return NextResponse.json('No pdf URL provided.')

  const openAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  })

  const fileID = await uploadFileToOpenAI(pdfLink, 'grant.pdf', openAI)
  if (!fileID) return NextResponse.json('Upload to OpenAI failed.')

  const assistant = await openAI.beta.assistants.create({
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
    file_ids: [fileID],
  })

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
            file_ids: [fileID],
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
  await openAI.files.del(fileID)
  await openAI.beta.assistants.del(assistant.id)

  if (runResults.status === 'failed') {
      if (runResults.last_error?.code === 'rate_limit_exceeded') {
          return NextResponse.json({
            code: 'rate_limit_exceeded',
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
  return NextResponse.json({criteria: toolCalls}, { status: 200 })
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

const uploadFileToOpenAI = async (
  fileUrl: string,
  fileName: string, // Must include extension.
  openAI: OpenAI,
): Promise<string | undefined> => {
  const filePath = await downloadFile(fileUrl, fileName)
  if (!filePath) return

  const file = await openAI.files.create({
      file: fs.createReadStream(filePath),
      purpose: 'assistants',
  })

  const deleteResult = deleteFile(filePath)
  if (!deleteResult) return

  return file.id
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
