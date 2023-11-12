"use client"
import { useCallback, useState } from "react"

export default function Home() {
  const [pdfLink, setPdfLink] = useState<string>("")
  const [result, setResult] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const getEligibility = useCallback(async () => {
    if (isLoading) return
    setResult("Loading...")
    if (!pdfLink) {
      setResult("Please enter a link to a PDF")
      return
    }
    setIsLoading(true)
    const res = await fetch("/api/parseEligibility", {
      method: "POST",
      body: JSON.stringify({ pdfLink }),
    })
    setIsLoading(false)

    if (!res.ok) {
      const resBody = await res.json()

      if (resBody.code === "openai_rate_limit_exceeded") {
        setResult("Looks like we're busy! We hit our OpenAI " +
        " rate limits, please try again later.")
        return
      }
      if (resBody.code === "rate_limit_exceeded") {
        setResult("You've hit our rate limit! Please try " +
        "again shortly.")
        return
      }
      if (resBody.code === "invalid_pdf_link") {
        setResult("PDF link is invalid")
        return
      }
      if (resBody.code === "unsupported_file_type") {
        setResult("The file at the link you uploaded was not " +
        "downloaded as a PDF by OpenAI. Please ensure the link is a " +
        "direct download link to a PDF.")
        return
      }

      if (resBody.errorMsg) {
        setResult(resBody.errorMsg)
        return
      }

      setResult("Unknown error occurred, please try again later.")
      return
    }

    const resJSON = await res.json()
    const criteria = resJSON.criteria.function.arguments
    if (!criteria) {
      setResult("The LLM couldn't find the criteria :( \n" +
      "Please try again.")
      return
    }
    const JSONCriteria = JSON.parse(criteria)
    const eligibility = JSONCriteria.eligibility
    const prettyCriteria = JSON.stringify(eligibility, null, 2)
    setResult(prettyCriteria)

  }, [isLoading, pdfLink])

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(result)
  }, [result])

  return (
    <div className="flex min-h-screen w-full justify-center">
      <div className="flex flex-col items-start w-2/3 space-y-8 mt-8">
        <span className="text-3xl">Grant eligibility parser</span>

        <input 
          className="border border-gray-400 p-2 rounded"
          type="text"
          placeholder="Link to PDF"
          onChange={(e) => setPdfLink(e.target.value)}
          value={pdfLink}
        />
        <button
          className="border border-gray-400 p-2 rounded bg-blue-500 text-white flex items-center h-12 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isLoading}
          onClick={getEligibility}
        >
          Get eligibility!
          {isLoading && <LoadingAnimation />}
        </button>
        <div className="flex flex-col w-full space-y-2">
          <button className="border border-gray-400 p-1 rounded bg-white0 text-gray-600 w-40"
            onClick={copyToClipboard}
          >
            Copy to clipboard
          </button>
          <textarea
            className="border border-gray-400 p-2 rounded"
            placeholder="Eligibility"
            value={result}
            onChange={(e) => setResult(e.target.value)}
            rows={20}
          />
        </div>
      </div>
    </div>
  )
}

const LoadingAnimation = () => {
  return (
    <div role="status">
        <svg aria-hidden="true" className=" ml-2 w-6 h-6 text-gray-200 animate-spin dark:text-gray-600 fill-white" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/>
            <path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/>
        </svg>
        <span className="sr-only">Loading...</span>
    </div>
  )
}
