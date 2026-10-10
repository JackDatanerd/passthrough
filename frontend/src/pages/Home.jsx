import { useMemo, useState } from 'react'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import HomeHero from '../components/home/HomeHero'
import StatsBand from '../components/home/StatsBand'
import BeforeAfter from '../components/home/BeforeAfter'
import Stories from '../components/home/Stories'
import HotCategories from '../components/home/HotCategories'
import VerifySection from '../components/home/VerifySection'
import HowItWorks from '../components/home/HowItWorks'
import PricingSection from '../components/home/PricingSection'
import EmployerSection from '../components/home/EmployerSection'
import HomeFaq from '../components/home/HomeFaq'
import FinalCta from '../components/home/FinalCta'
import StickyScanCta from '../components/home/StickyScanCta'
import { usePricing } from '../hooks/usePricing'
import useHomeData from '../hooks/useHomeData'
import { getStoredReferralCode } from '../hooks/useReferralCapture'
import { ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES, FREE_SCANS_PER_DAY, ANON_SCANS_PER_HOUR } from '../lib/scoreThresholds'
import { ATS_NAMES, buildFaq } from '../lib/homeContent'

// The homepage is a conversion page: scan first, prove it second, price it third. Every section is its
// own component under components/home/, and every copy block / sample lives in lib/homeContent.js.
//
// Numbers the page quotes about the PRODUCT (free-scan limits, the Verified threshold, the retry count)
// come from /api/pricing, which reads them from the backend's own constants — the page used to hardcode
// all four, so it silently went stale the day any of them changed (Pricing.jsx already read them live).
// The constants in lib/scoreThresholds.js are only the fallback for the moment before that answer lands.
export default function Home() {
  // Seeded from storage while rendering (getStoredReferralCode also captures a ?ref= in the URL right
  // now), so a visitor from a partner's link sees the discounted prices on the very first paint — the
  // teaser used to ask for the public price and showed everyone the same numbers.
  const [referralCode] = useState(getStoredReferralCode())
  const { pricing, byTier, refresh, clockOffsetMs } = usePricing(referralCode)
  const data = useHomeData()

  const badgeThreshold   = pricing?.badgeThreshold   ?? ATS_BADGE_THRESHOLD
  const maxFixRetries    = pricing?.maxFixRetries    ?? MAX_FIX_RETRIES
  const freeScansPerDay  = pricing?.freeScansPerDay  ?? FREE_SCANS_PER_DAY
  const anonScansPerHour = pricing?.anonScansPerHour ?? ANON_SCANS_PER_HOUR
  const limits = { badgeThreshold, maxFixRetries, freeScansPerDay, anonScansPerHour }
  const faq = useMemo(() => buildFaq({ badgeThreshold, maxFixRetries, freeScansPerDay, anonScansPerHour }),
    [badgeThreshold, maxFixRetries, freeScansPerDay, anonScansPerHour])

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1">
        <HomeHero data={data} />

        <div className="border-b border-gray-100 bg-gray-50 py-4">
          <div className="max-w-5xl mx-auto px-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-1.5 text-sm text-gray-500">
            <span className="font-semibold text-gray-700">Scored the way employers actually filter:</span>
            {ATS_NAMES.map(n => <span key={n} className="font-bold text-gray-600">{n}</span>)}
          </div>
        </div>

        <StatsBand data={data} badgeThreshold={badgeThreshold} />
        <BeforeAfter />
        <Stories stories={data.stories} badgeThreshold={badgeThreshold} />
        <HotCategories hot={data.hot} minReports={data.minReports} />
        <VerifySection badgeThreshold={badgeThreshold} />
        <HowItWorks />
        <PricingSection pricing={pricing} byTier={byTier} refresh={refresh} clockOffsetMs={clockOffsetMs}
          referralCode={referralCode} limits={limits} />
        <EmployerSection />
        <HomeFaq items={faq} />
        <FinalCta />
      </main>
      <Footer />
      <StickyScanCta />
    </div>
  )
}
