import { ArrowForward, ExpandMore } from '@mui/icons-material';
import { Accordion, AccordionDetails, AccordionSummary, Box, Link as MuiLink, Paper, Stack, Typography } from '@mui/material';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { helpEn } from '#shared/i18n/help/en.ts';
import { helpRu, type Help } from '#shared/i18n/help/ru.ts';
import ApiSection from './HelpPage/ApiSection.tsx';
import Diagrams from './HelpPage/Diagrams.tsx';

const GUIDES: Record<string, Help> = { ru: helpRu, en: helpEn };

// Three levels that read apart: the page (h1), its sections (h2, a card each),
// and the headings inside a section — a principle, a diagram, a topic (h3).
const SECTION = { fontWeight: 600 } as const;
const SUBHEAD = { fontWeight: 600, color: 'text.primary' } as const;

/** A topic of the use cases or the answers: its title over its folds. */
function Group(p: { id: string; title: string; children: ReactNode }) {
  return (
    <Box component="section" id={p.id} aria-label={p.title} sx={{ mt: 3, scrollMarginTop: 72 }}>
      <Typography variant="h3" component="h3" sx={{ ...SUBHEAD, mb: 0.5 }}>{p.title}</Typography>
      {p.children}
    </Box>
  );
}

/** One use case or answer, folded to its title. */
function Fold(p: { title: string; children: ReactNode }) {
  return (
    <Accordion disableGutters elevation={0} sx={{ '&:before': { display: 'none' }, borderBottom: 1, borderColor: 'divider' }}>
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography>{p.title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{p.children}</AccordionDetails>
    </Accordion>
  );
}

/** A line of the contents. */
function Entry(p: { to: string; title: string; nested?: boolean }) {
  return (
    <Typography component="li" variant="body2" sx={{ ml: p.nested ? 2 : 0, listStyle: 'none', fontWeight: p.nested ? 400 : 600, mt: p.nested ? 0.25 : 1 }}>
      <MuiLink component={Link} to={`#${p.to}`}>{p.title}</MuiLink>
    </Typography>
  );
}

/**
 * The guide (`/help`, decision 62), over My day like a task, in the order a
 * newcomer needs it (decisions 80, 92): the principles, each with the usual
 * things it replaces, five steps for the first day, diagrams of
 * the screen, the roles, a task's life and a task of one's own, how to do the usual
 * things and why the unusual rules are so, both by topic — in the person's language, written for it,
 * not translated word by word.
 */
export default function () {
  const { i18n } = useTranslation();
  const help = GUIDES[i18n.language] ?? helpRu;
  const { hash } = useLocation();
  // A place named in the address, from the contents or another screen.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <Stack spacing={2} sx={{ width: '100%', maxWidth: 960, mx: 'auto', alignSelf: 'flex-start' }}>
      <Paper sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h1" sx={{ fontWeight: 600, mb: 1 }}>{help.title}</Typography>
        <Box component="nav" aria-label={help.contents} sx={{ mt: 1.5 }}>
          <Typography variant="h3" component="h2" sx={SUBHEAD}>{help.contents}</Typography>
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            <Entry to="principles" title={help.principlesTitle} />
            <Entry to="first-day" title={help.quickStartTitle} />
            <Entry to="how-it-works" title={help.diagramsTitle} />
            <Entry to="how-to" title={help.scenariosTitle} />
            {help.scenarios.map((group, i) => <Entry key={group.title} to={`how-to-${i}`} title={group.title} nested />)}
            <Entry to="why" title={help.faqTitle} />
            {help.faq.map((group, i) => <Entry key={group.title} to={`why-${i}`} title={group.title} nested />)}
            <Entry to="api" title={help.api.title} />
            {[['api-choose', help.api.choose.title], ['api-calling', help.api.calling.title], ['api-methods', help.api.methods.title],
              ['api-errors', help.api.errors.title], ['api-webhooks', help.api.webhooks.title], ['api-keys', help.api.keys.title],
              ['api-bots', help.api.bots.title]].map(([to, title]) => <Entry key={to} to={to!} title={title!} nested />)}
          </Box>
        </Box>
        <Typography id="principles" sx={{ mt: 3, mb: 1, scrollMarginTop: 72 }}>{help.intro}</Typography>
        {help.principles.map((principle, i) => (
          <Box key={principle.title} component="section" aria-label={principle.title} sx={{ mt: 3 }}>
            <Typography variant="h3" component="h2" sx={SUBHEAD}>{i + 1}. {principle.title}</Typography>
            <Typography sx={{ mt: 0.5, mb: 1 }}>{principle.text}</Typography>
            {principle.instead.map((row) => (
              <Box
                key={row.usual}
                sx={{
                  display: 'grid', alignItems: 'center', columnGap: 1.5, rowGap: 0.5, py: 1, borderTop: 1, borderColor: 'divider',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr) 16px minmax(0, 1fr)', sm: '190px 16px 210px minmax(0, 1fr)' },
                }}
              >
                <Typography component="s" sx={{ color: 'text.secondary' }}>{row.usual}</Typography>
                <ArrowForward sx={{ fontSize: 16, color: 'text.secondary' }} />
                <Typography sx={{ fontWeight: 600 }}>{row.yartt}</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', gridColumn: { xs: '1 / -1', sm: 'auto' } }}>{row.text}</Typography>
              </Box>
            ))}
          </Box>
        ))}
      </Paper>

      <Paper component="section" id="first-day" aria-label={help.quickStartTitle} sx={{ p: { xs: 2, sm: 3 }, scrollMarginTop: 72 }}>
        <Typography variant="h2" sx={{ ...SECTION, mb: 1.5 }}>{help.quickStartTitle}</Typography>
        <Box component="ol" sx={{ m: 0, pl: 3 }}>
          {help.quickStart.map((step) => <Typography key={step} component="li" sx={{ mb: 1 }}>{step}</Typography>)}
        </Box>
      </Paper>

      <Paper component="section" id="how-it-works" aria-label={help.diagramsTitle} sx={{ p: { xs: 2, sm: 3 }, scrollMarginTop: 72 }}>
        <Typography variant="h2" sx={{ ...SECTION, mb: 2 }}>{help.diagramsTitle}</Typography>
        <Diagrams diagrams={help.diagrams} />
      </Paper>

      <Paper id="how-to" sx={{ p: { xs: 2, sm: 3 }, scrollMarginTop: 72 }}>
        <Typography variant="h2" sx={SECTION}>{help.scenariosTitle}</Typography>
        {help.scenarios.map((group, i) => (
          <Group key={group.title} id={`how-to-${i}`} title={group.title}>
            {group.items.map((scenario) => (
              <Fold key={scenario.title} title={scenario.title}>
                <Box component="ol" sx={{ m: 0, pl: 3 }}>
                  {scenario.steps.map((step) => <Typography key={step} component="li" variant="body2" sx={{ mb: 0.5 }}>{step}</Typography>)}
                </Box>
                {'more' in scenario && scenario.more && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    <MuiLink component={Link} to={`#${scenario.more.to}`}>{scenario.more.label}</MuiLink>
                  </Typography>
                )}
              </Fold>
            ))}
          </Group>
        ))}
      </Paper>

      <Paper id="why" sx={{ p: { xs: 2, sm: 3 }, scrollMarginTop: 72 }}>
        <Typography variant="h2" sx={SECTION}>{help.faqTitle}</Typography>
        {help.faq.map((group, i) => (
          <Group key={group.title} id={`why-${i}`} title={group.title}>
            {group.items.map((item) => (
              <Fold key={item.q} title={item.q}>
                <Typography variant="body2">{item.a}</Typography>
              </Fold>
            ))}
          </Group>
        ))}
      </Paper>

      <Paper component="section" id="api" aria-label={help.api.title} sx={{ p: { xs: 2, sm: 3 }, scrollMarginTop: 72 }}>
        <Typography variant="h2" sx={SECTION}>{help.api.title}</Typography>
        <ApiSection api={help.api} />
      </Paper>
    </Stack>
  );
}
