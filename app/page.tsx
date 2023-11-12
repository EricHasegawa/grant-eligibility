"use client"
import { useCallback, useState } from "react"

export default function Home() {
  const [pdfLink, setPdfLink] = useState<string>("")
  const [result, setResult] = useState<string>("")

  const getEligibility = useCallback(async () => {
    if (!pdfLink) {
      setResult("Please enter a link to a PDF")
      return
    }
    const res = await fetch("/api/parseEligibility", {
      method: "POST",
      body: JSON.stringify({ pdfLink }),
    })

    if (!res.ok) {
      if (res.status === 429) {
        setResult("Looks like we're busy! We hit our OpenAI " +
        " rate limits, please try again later.")
        return
      } 

      const resBody = await res.json()
      if (resBody.errorMsg) {
        setResult(resBody.errorMsg)
        return
      }
      setResult("Unknown error occurred, please try again later.")
      return
    }
    const json = await res.text()
    setResult(json)

  }, [pdfLink])

  return (
    <div className="flex min-h-screen flex-col items-center space-y-8 p-24">
      <span className="text-3xl">Grant eligibility parser</span>

      <div className="flex items-center">
        <span className="mr-3">Link to PDF</span>
        <input 
          className="border border-gray-400 p-2 rounded"
          type="text"
          onChange={(e) => setPdfLink(e.target.value)}
          value={pdfLink}
        />
      </div>
      <div>
        <button
          className="border border-gray-400 p-2 rounded bg-blue-500 text-white"
          onClick={getEligibility}
        >
          Get eligibility!
        </button>
      </div>
      <div className="flex flex-col w-1/3 space-y-4">
        <textarea
          className="border border-gray-400 p-2 rounded"
          placeholder="Eligibility"
          value={result}
          onChange={(e) => setResult(e.target.value)}
          rows={20}
        />
      </div>
    </div>
  )
}
