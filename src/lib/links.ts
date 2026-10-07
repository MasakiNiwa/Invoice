/** 国税庁 適格請求書発行事業者公表サイトの登録番号詳細ページ */
export function invoiceKohyoUrl(digits13: string): string {
  return `https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=${encodeURIComponent(digits13)}`
}

/** 国税庁 法人番号公表サイト(法人の場合のみ該当) */
export function houjinBangouUrl(digits13: string): string {
  return `https://www.houjin-bangou.nta.go.jp/henkorireki-johoto.html?selHouzinNo=${encodeURIComponent(digits13)}`
}

export const REPO_URL = 'https://github.com/MasakiNiwa/Invoice'
export const PAGES_URL = 'https://masakiniwa.github.io/Invoice/'
