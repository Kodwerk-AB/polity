import { describe, expect, it } from 'vitest'
import { statedSeats } from './source'
import { compositionField, switchBranch, transcludedTemplate } from './composition'

/**
 * Every fixture below is verbatim markup from the named article, captured live.
 * The parser exists because these five shapes are all real and all different.
 */

describe('compositionField', () => {
  it('reads a field that lists parties directly', () => {
    // El Salvador — the clean case, with the government/opposition split as
    // bold headers, which is what no structured source publishes.
    const markup = `{{Infobox legislature
| members           = 60 deputies
| political_groups1 = '''[[Cabinet of Nayib Bukele|Government]] (57)'''
* {{color box|x}} [[Nuevas Ideas]] (54)
* {{color box|x}} [[National Coalition Party (El Salvador)|PCN]] (2)
'''Opposition (3)'''
* {{color box|x}} [[Nationalist Republican Alliance|ARENA]] (2)
| committees1       = 8
}}`
    const field = compositionField(markup)
    expect(field).toContain('Nuevas Ideas')
    expect(field).toContain('ARENA')
    // It must stop at the next field, not run to the end of the infobox.
    expect(field).not.toContain('committees1')
  })

  it('stops at the closing braces when the field is last', () => {
    const markup = `{{Infobox legislature
| political_groups1 = * [[A Party]] (10)
}}`
    expect(compositionField(markup)).toBe('* [[A Party]] (10)')
  })

  it('returns nothing when the article carries no such field', () => {
    expect(compositionField('{{Infobox legislature\n| members = 100\n}}')).toBeUndefined()
    expect(compositionField('')).toBeUndefined()
  })
})

describe('transcludedTemplate', () => {
  it('spots a field that defers to a template', () => {
    // Britain writes the composition into a template and points at it, so the
    // field alone reads as fourteen characters of nothing.
    expect(transcludedTemplate('{{UK Parliament political groups|Commons}}')).toEqual({
      title: 'Template:UK Parliament political groups',
      parameter: 'Commons',
    })
  })

  it('ignores the formatting templates a real list is made of', () => {
    // These wrap parties; they do not replace them. Following one would fetch
    // the template's own documentation instead of a composition.
    for (const wrapper of ['{{plainlist}}', '{{ubl}}', '{{Composition bar}}', '{{colour box}}']) {
      expect(transcludedTemplate(wrapper), wrapper).toBeUndefined()
    }
  })

  it('ignores a field that is a list rather than a single pointer', () => {
    expect(transcludedTemplate('* [[A]] (1)\n* [[B]] (2)')).toBeUndefined()
  })
})

describe('switchBranch', () => {
  it('takes one chamber out of a two-chamber switch template', () => {
    // Britain keeps Commons and Lords in one template. Handing the model both
    // would ask it to merge two houses into one composition.
    const template = `<noinclude>docs</noinclude><includeonly>{{#switch:{{{1|Commons}}}</includeonly>
|<includeonly>Commons=</includeonly>
'''HM Government''' [[Labour Party (UK)|Labour]] (405)
|<includeonly>Lords=</includeonly>
'''Lords''' [[Conservative]] (270)`
    const commons = switchBranch(template, 'Commons')
    expect(commons).toContain('Labour')
    expect(commons).not.toContain('Conservative')
  })

  it('returns nothing when the branch is not in the template', () => {
    expect(switchBranch('no switch here', 'Commons')).toBeUndefined()
  })
})

describe('statedSeats', () => {
  it('reads a plain seats field', () => {
    expect(statedSeats('| seats = 300\n| other = x')).toBe(300)
  })

  it('reads a decorated seats field', () => {
    expect(statedSeats("| seats = '''545''' <ref>note</ref>\n")).toBe(545)
  })

  it('refuses an EMPTY field that runs into the next one', () => {
    // Egypt's Senate: `| seats = | structure1 = File:Egypt Senate 2026.svg`.
    // The first integer on the line was the YEAR in a filename, so a 300-seat
    // chamber was published as 2026.
    expect(statedSeats('| seats = | structure1 = File:Egypt Senate 2026.svg\n')).toBeUndefined()
  })

  it('ignores a year inside a file reference', () => {
    expect(statedSeats('| seats = [[File:Senate 2026.svg]] 300\n')).toBe(300)
  })

  it('refuses a count no national chamber could have', () => {
    expect(statedSeats('| seats = 4\n')).toBeUndefined()
    expect(statedSeats('| seats = 9999\n')).toBeUndefined()
  })
})
